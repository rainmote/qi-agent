use crate::{
    Cursor,
    paths::{RuntimePaths, canonical, discover_repository_root, set_owner_only_file},
    wire,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

static PROCESS_CLIENT_ID: OnceLock<String> = OnceLock::new();

pub struct DaemonConnection {
    pub reader: BufReader<UnixStream>,
    pub writer: BufWriter<UnixStream>,
    pub client_id: String,
    pub agent_id: Option<String>,
    pub backlog: Vec<Value>,
}

pub struct AttachedAgent {
    pub connection: DaemonConnection,
    pub snapshot: Value,
    pub attach_result: Value,
}

impl DaemonConnection {
    pub fn connect(paths: &RuntimePaths, client_id: String) -> Result<Self> {
        let stream = UnixStream::connect(&paths.public_socket).with_context(|| {
            format!(
                "could not connect to daemon at {}",
                paths.public_socket.display()
            )
        })?;
        stream.set_read_timeout(Some(Duration::from_secs(65)))?;
        Ok(Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: BufWriter::new(stream),
            client_id,
            agent_id: None,
            backlog: Vec::new(),
        })
    }

    pub fn call(&mut self, method: &str, parameters: Value) -> Result<Value> {
        let request_id = format!("request-{}", Uuid::new_v4());
        let command_id = wire::mutation(method).then(|| format!("command-{}", Uuid::new_v4()));
        let value = wire::command(
            request_id.clone(),
            self.client_id.clone(),
            command_id,
            self.agent_id.clone(),
            method,
            parameters,
        );
        serde_json::to_writer(&mut self.writer, &value)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        let mut snapshot_transfers = HashMap::<String, Vec<Option<String>>>::new();
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line)? == 0 {
                bail!("daemon disconnected while waiting for {method}")
            }
            if line.trim().is_empty() {
                continue;
            }
            let envelope: Value = serde_json::from_str(line.trim())?;
            match envelope.get("type").and_then(Value::as_str) {
                Some("snapshot.begin") => {
                    let transfer_id = envelope
                        .get("transfer_id")
                        .and_then(Value::as_str)
                        .context("snapshot.begin has no transfer_id")?;
                    let chunks = envelope
                        .get("chunks")
                        .and_then(Value::as_u64)
                        .context("snapshot.begin has no chunk count")?;
                    snapshot_transfers
                        .insert(transfer_id.to_owned(), vec![None; usize::try_from(chunks)?]);
                    continue;
                }
                Some("snapshot.chunk") => {
                    let transfer_id = envelope
                        .get("transfer_id")
                        .and_then(Value::as_str)
                        .context("snapshot.chunk has no transfer_id")?;
                    let index = envelope
                        .get("index")
                        .and_then(Value::as_u64)
                        .context("snapshot.chunk has no index")?;
                    let data = envelope
                        .get("data")
                        .and_then(Value::as_str)
                        .context("snapshot.chunk has no data")?;
                    let transfer = snapshot_transfers
                        .get_mut(transfer_id)
                        .context("snapshot.chunk arrived before snapshot.begin")?;
                    let slot = transfer
                        .get_mut(usize::try_from(index)?)
                        .context("snapshot.chunk index is out of range")?;
                    *slot = Some(data.to_owned());
                    continue;
                }
                Some("snapshot.end") => continue,
                _ => {}
            }
            if envelope.get("type").and_then(Value::as_str) == Some("response")
                && envelope.get("id").and_then(Value::as_str) == Some(request_id.as_str())
            {
                if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                    let result = envelope.get("result").cloned().unwrap_or(Value::Null);
                    return hydrate_snapshot(result, &mut snapshot_transfers);
                }
                let message = envelope
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("daemon request failed");
                bail!("{message}")
            }
            self.backlog.push(envelope);
        }
    }
}

fn hydrate_snapshot(
    mut result: Value,
    transfers: &mut HashMap<String, Vec<Option<String>>>,
) -> Result<Value> {
    let Some(transfer_id) = result
        .get("snapshot_transfer_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(result);
    };
    let chunks = transfers
        .remove(&transfer_id)
        .with_context(|| format!("snapshot transfer was not received: {transfer_id}"))?;
    let mut serialized = String::new();
    for (index, chunk) in chunks.into_iter().enumerate() {
        serialized.push_str(
            &chunk.with_context(|| format!("snapshot transfer is missing chunk {index}"))?,
        );
    }
    let snapshot: Value = serde_json::from_str(&serialized)?;
    if result.as_object().is_some_and(|object| object.len() == 1) {
        return Ok(snapshot);
    }
    let object = result
        .as_object_mut()
        .context("chunked attach result must be an object")?;
    object.remove("snapshot_transfer_id");
    object.insert("snapshot".into(), snapshot);
    Ok(result)
}

pub fn connect_or_launch(
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<DaemonConnection> {
    let paths = RuntimePaths::discover()?;
    let client_id = load_client_id(&paths)?;
    if let Ok(connection) = DaemonConnection::connect(&paths, client_id.clone()) {
        return Ok(connection);
    }
    launch_daemon(&paths, repository_root, config_path)?;
    let started = Instant::now();
    loop {
        if let Ok(connection) = DaemonConnection::connect(&paths, client_id.clone()) {
            return Ok(connection);
        }
        if started.elapsed() >= Duration::from_secs(10) {
            bail!(
                "dao daemon did not start; inspect {}",
                paths.logs_dir.join("daemon.log").display()
            )
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn attach_or_create(
    requested_agent: Option<&str>,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
    repl_backend: Option<&str>,
) -> Result<AttachedAgent> {
    let requested_config = config_path.map(canonical).transpose()?;
    let mut connection = connect_or_launch(repository_root, config_path)?;
    let hello = connection.call("daemon.hello", json!({}))?;
    if repl_backend.is_some()
        && !hello
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|value| value.as_str() == Some("repl.backend-selection.v1"))
            })
    {
        bail!(
            "the running dao daemon does not support per-agent REPL selection; restart it when current background tasks are safe to stop"
        )
    }
    let workspace = canonical(std::env::current_dir()?)?;
    let agent_id = if let Some(agent_id) = requested_agent {
        agent_id.to_owned()
    } else {
        let agents = connection.call("agent.list", json!({}))?;
        let existing = agents.as_array().and_then(|values| {
            values.iter().find(|agent| {
                agent.get("workspace_path").and_then(Value::as_str)
                    == Some(workspace.to_string_lossy().as_ref())
                    && requested_config.as_ref().is_none_or(|config| {
                        agent.get("config_path").and_then(Value::as_str)
                            == Some(config.to_string_lossy().as_ref())
                    })
                    && repl_backend.is_none_or(|backend| {
                        agent.get("repl_backend").and_then(Value::as_str) == Some(backend)
                    })
                    && !matches!(
                        agent.get("status").and_then(Value::as_str),
                        Some("stopped" | "failed")
                    )
            })
        });
        if let Some(agent) = existing {
            agent
                .get("agent_id")
                .and_then(Value::as_str)
                .context("agent record has no agent_id")?
                .to_owned()
        } else {
            let created = connection.call(
                "agent.create",
                json!({
                    "workspace": workspace,
                    "name": workspace.file_name(),
                    "config_path": requested_config,
                    "repl_backend": repl_backend,
                }),
            )?;
            created
                .pointer("/agent/agent_id")
                .and_then(Value::as_str)
                .context("daemon did not return a new agent_id")?
                .to_owned()
        }
    };
    connection.agent_id = Some(agent_id.clone());
    let attach_result = match connection.call("agent.attach", json!({"agent_id": agent_id})) {
        Ok(value) => value,
        Err(error) if requested_agent.is_none() => {
            let created = connection.call(
                "agent.create",
                json!({
                    "workspace": workspace,
                    "name": workspace.file_name(),
                    "config_path": requested_config,
                    "repl_backend": repl_backend,
                }),
            )?;
            let fresh = created
                .pointer("/agent/agent_id")
                .and_then(Value::as_str)
                .context("daemon did not return a new agent_id")?
                .to_owned();
            connection.agent_id = Some(fresh.clone());
            connection
                .call("agent.attach", json!({"agent_id": fresh}))
                .with_context(|| format!("could not attach existing or new agent: {error}"))?
        }
        Err(error) => return Err(error),
    };
    let snapshot = attach_result
        .get("snapshot")
        .cloned()
        .context("attach response did not contain a snapshot")?;
    Ok(AttachedAgent {
        connection,
        snapshot,
        attach_result,
    })
}

pub fn attach_existing_with_cursor(
    agent_id: &str,
    cursor: Cursor,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<AttachedAgent> {
    let mut connection = connect_or_launch(repository_root, config_path)?;
    connection.call("daemon.hello", json!({}))?;
    connection.agent_id = Some(agent_id.to_owned());
    let attach_result = connection.call(
        "agent.attach",
        json!({
            "agent_id": agent_id,
            "cursor": {
                "generation": cursor.generation,
                "sequence": cursor.sequence
            }
        }),
    )?;
    let snapshot = attach_result
        .get("snapshot")
        .cloned()
        .context("attach response did not contain a snapshot")?;
    Ok(AttachedAgent {
        connection,
        snapshot,
        attach_result,
    })
}

pub fn launch_daemon(
    paths: &RuntimePaths,
    repository_root: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<()> {
    let repository_root = discover_repository_root(repository_root)?;
    let config_path = config_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repository_root.join("agent.edn"));
    let executable = std::env::current_exe()?;
    let log_path = paths.logs_dir.join("daemon.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    set_owner_only_file(&log_path)?;
    let stderr = log.try_clone()?;
    let mut command = Command::new(executable);
    command
        .arg("daemon")
        .arg("serve")
        .arg("--repository-root")
        .arg(repository_root)
        .arg("--config")
        .arg(config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().context("could not launch dao daemon")?;
    Ok(())
}

fn load_client_id(paths: &RuntimePaths) -> Result<String> {
    if let Some(value) = PROCESS_CLIENT_ID.get() {
        return Ok(value.clone());
    }
    let installation_id = if let Ok(value) = fs::read_to_string(&paths.client_id) {
        let value = value.trim();
        if !value.is_empty() {
            value.to_owned()
        } else {
            create_installation_id(paths)?
        }
    } else {
        create_installation_id(paths)?
    };
    let value = format!("{installation_id}/process-{}", Uuid::new_v4());
    let _ = PROCESS_CLIENT_ID.set(value.clone());
    Ok(PROCESS_CLIENT_ID.get().cloned().unwrap_or(value))
}

fn create_installation_id(paths: &RuntimePaths) -> Result<String> {
    let value = format!("installation-{}", Uuid::new_v4());
    fs::write(&paths.client_id, format!("{value}\n"))?;
    set_owner_only_file(&paths.client_id)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_snapshot_is_reassembled_into_attach_result() {
        let mut transfers = HashMap::from([(
            "snapshot-1".into(),
            vec![
                Some("{\"session_id\":\"会".into()),
                Some("话\",\"events\":[]}".into()),
            ],
        )]);
        let result = hydrate_snapshot(
            json!({"agent": {"agent_id": "a"}, "snapshot_transfer_id": "snapshot-1"}),
            &mut transfers,
        )
        .unwrap();
        assert_eq!(result.pointer("/snapshot/session_id"), Some(&json!("会话")));
        assert!(transfers.is_empty());
    }
}
