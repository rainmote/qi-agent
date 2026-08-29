use crate::paths::{RuntimePaths, set_owner_only_file};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    os::unix::{
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const EVENT_BUFFER_LIMIT: usize = 2_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkerDescriptor {
    pub version: u32,
    pub worker_id: String,
    pub agent_id: String,
    pub root_agent_id: String,
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub session_path: PathBuf,
    pub repository_root: PathBuf,
    pub config_path: PathBuf,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub repl_backend: Option<String>,
    pub socket_path: PathBuf,
    pub token: String,
    pub generation: u64,
    pub pid: Option<u32>,
    pub child_pid: Option<u32>,
    pub session_id: Option<String>,
    pub status: String,
    pub started_at_ms: u128,
}

impl WorkerDescriptor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        paths: &RuntimePaths,
        worker_id: String,
        agent_id: String,
        workspace_id: String,
        workspace_path: PathBuf,
        session_path: PathBuf,
        repository_root: PathBuf,
        config_path: PathBuf,
        token: String,
    ) -> Self {
        Self {
            version: 1,
            socket_path: paths.worker_socket(&worker_id),
            root_agent_id: agent_id.clone(),
            worker_id,
            agent_id,
            workspace_id,
            workspace_path,
            session_path,
            repository_root,
            config_path,
            preset_id: None,
            repl_backend: None,
            token,
            generation: 1,
            pid: None,
            child_pid: None,
            session_id: None,
            status: "starting".into(),
            started_at_ms: now_ms(),
        }
    }
}

type ActiveWriter = Arc<Mutex<Option<(u64, UnixStream)>>>;
type ActiveStdin = Arc<Mutex<Option<BufWriter<ChildStdin>>>>;

pub fn read_descriptor(path: &Path) -> Result<WorkerDescriptor> {
    serde_json::from_slice(
        &fs::read(path)
            .with_context(|| format!("could not read worker descriptor {}", path.display()))?,
    )
    .with_context(|| format!("invalid worker descriptor {}", path.display()))
}

pub fn write_descriptor(path: &Path, descriptor: &WorkerDescriptor) -> Result<()> {
    let parent = path
        .parent()
        .context("worker descriptor has no parent directory")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".worker-{}.tmp", descriptor.worker_id));
    let data = serde_json::to_vec_pretty(descriptor)?;
    fs::write(&temporary, data)?;
    set_owner_only_file(&temporary)?;
    fs::rename(&temporary, path)?;
    set_owner_only_file(path)?;
    Ok(())
}

pub fn serve(descriptor_path: &Path) -> Result<()> {
    let descriptor_path = descriptor_path.to_path_buf();
    let descriptor = read_descriptor(&descriptor_path)?;
    let log_directory = RuntimePaths::discover()?.logs_dir;
    let lease_path = PathBuf::from(format!("{}.writer.lock", descriptor.session_path.display()));
    if let Some(parent) = lease_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lease = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lease_path)
        .with_context(|| format!("could not open session lease {}", lease_path.display()))?;
    set_owner_only_file(&lease_path)?;
    lease.try_lock_exclusive().with_context(|| {
        format!(
            "session is already owned: {}",
            descriptor.session_path.display()
        )
    })?;

    if descriptor.socket_path.exists() {
        let _ = fs::remove_file(&descriptor.socket_path);
    }
    let listener = UnixListener::bind(&descriptor.socket_path).with_context(|| {
        format!(
            "could not bind worker socket {}",
            descriptor.socket_path.display()
        )
    })?;
    set_owner_only_file(&descriptor.socket_path)?;
    listener.set_nonblocking(true)?;

    let stdin: ActiveStdin = Arc::new(Mutex::new(None));
    let active: ActiveWriter = Arc::new(Mutex::new(None));
    let event_buffer = Arc::new(Mutex::new(VecDeque::<Value>::new()));
    let sequence = Arc::new(AtomicU64::new(0));
    let live_descriptor = Arc::new(Mutex::new(descriptor.clone()));
    let shutdown_requested = Arc::new(AtomicBool::new(false));
    let mut child = start_babashka(
        &live_descriptor,
        Arc::clone(&active),
        Arc::clone(&event_buffer),
        Arc::clone(&sequence),
        Arc::clone(&stdin),
        &descriptor_path,
    )?;
    let mut child_started = Instant::now();
    let mut restart_attempts = 0u32;

    let connection_epoch = AtomicU64::new(0);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                let epoch = connection_epoch.fetch_add(1, Ordering::SeqCst) + 1;
                if let Err(error) = authenticate_and_attach(
                    stream,
                    epoch,
                    &descriptor.token,
                    Arc::clone(&active),
                    Arc::clone(&stdin),
                    Arc::clone(&event_buffer),
                    Arc::clone(&live_descriptor),
                    Arc::clone(&shutdown_requested),
                ) {
                    append_log(
                        &log_directory,
                        &descriptor.worker_id,
                        &format!("private connection rejected: {error:#}\n"),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error).context("worker private socket failed"),
        }

        if let Some(status) = child.try_wait()? {
            *stdin.lock().expect("worker stdin mutex poisoned") = None;
            let mut current = live_descriptor.lock().expect("descriptor mutex poisoned");
            let intentional = shutdown_requested.load(Ordering::SeqCst);
            current.status = if intentional && status.success() {
                "stopped".into()
            } else {
                "failed".into()
            };
            current.child_pid = None;
            write_descriptor(&descriptor_path, &current)?;
            let exit_event = json!({
                "version": 1,
                "type": "event",
                "event": "worker/exited",
                "durable": false,
                "generation": current.generation,
                "cursor": {
                    "generation": current.generation,
                    "sequence": sequence.fetch_add(1, Ordering::SeqCst) + 1
                },
                "data": {"status": status.code(), "worker_id": current.worker_id}
            });
            send_active(&active, &exit_event);
            if intentional {
                break;
            }
            if child_started.elapsed() >= Duration::from_secs(30) {
                restart_attempts = 0;
            }
            restart_attempts += 1;
            if restart_attempts > 5 {
                append_log(
                    &log_directory,
                    &descriptor.worker_id,
                    "worker restart budget exhausted after 5 consecutive failures\n",
                );
                break;
            }
            let delay_ms = (100u64 << (restart_attempts - 1)).min(2_000);
            current.generation += 1;
            current.status = "recovering".into();
            current.started_at_ms = now_ms();
            write_descriptor(&descriptor_path, &current)?;
            let next_generation = current.generation;
            drop(current);
            sequence.store(0, Ordering::SeqCst);
            event_buffer
                .lock()
                .expect("event buffer mutex poisoned")
                .clear();
            send_active(
                &active,
                &json!({
                    "version": 1,
                    "type": "event",
                    "event": "worker/restarting",
                    "durable": false,
                    "generation": next_generation,
                    "cursor": {"generation": next_generation, "sequence": 0},
                    "data": {"worker_id": descriptor.worker_id,
                             "attempt": restart_attempts,
                             "delay_ms": delay_ms,
                             "outcome": "uncertain"}
                }),
            );
            thread::sleep(Duration::from_millis(delay_ms));
            child = start_babashka(
                &live_descriptor,
                Arc::clone(&active),
                Arc::clone(&event_buffer),
                Arc::clone(&sequence),
                Arc::clone(&stdin),
                &descriptor_path,
            )?;
            child_started = Instant::now();
        }
        thread::sleep(Duration::from_millis(40));
    }

    let _ = fs::remove_file(&descriptor.socket_path);
    drop(lease);
    Ok(())
}

fn start_babashka(
    descriptor: &Arc<Mutex<WorkerDescriptor>>,
    active: ActiveWriter,
    event_buffer: Arc<Mutex<VecDeque<Value>>>,
    sequence: Arc<AtomicU64>,
    stdin: ActiveStdin,
    descriptor_path: &Path,
) -> Result<std::process::Child> {
    let snapshot = descriptor
        .lock()
        .expect("descriptor mutex poisoned")
        .clone();
    let classpath = std::env::join_paths([
        snapshot.repository_root.join("src"),
        snapshot.repository_root.join("plugins"),
    ])?;
    let mut command = Command::new("bb");
    command
        .arg("-cp")
        .arg(classpath)
        .arg("-m")
        .arg("agent.cli")
        .arg("--config")
        .arg(&snapshot.config_path)
        .arg("--session")
        .arg(&snapshot.session_path)
        .arg("--mode")
        .arg("rpc")
        .current_dir(&snapshot.workspace_path)
        .env("DAO_AGENT_ID", &snapshot.agent_id)
        .env("DAO_WORKER_ID", &snapshot.worker_id)
        .env("DAO_WORKER_GENERATION", snapshot.generation.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(backend) = &snapshot.repl_backend {
        command.env("DAO_REPL_BACKEND", backend);
    }
    if let Some(seconds) = std::env::var("DAO_WORKER_CPU_SECONDS")
        .ok()
        .and_then(|value| value.parse::<libc::rlim_t>().ok())
        .filter(|value| *value > 0)
    {
        unsafe {
            command.pre_exec(move || {
                let limit = libc::rlimit {
                    rlim_cur: seconds,
                    rlim_max: seconds,
                };
                if libc::setrlimit(libc::RLIMIT_CPU, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .context("could not start resident Babashka worker")?;
    *stdin.lock().expect("worker stdin mutex poisoned") = Some(BufWriter::new(
        child.stdin.take().context("worker stdin was unavailable")?,
    ));
    {
        let mut current = descriptor.lock().expect("descriptor mutex poisoned");
        current.pid = Some(std::process::id());
        current.child_pid = Some(child.id());
        current.status = "running".into();
        current.started_at_ms = now_ms();
        write_descriptor(descriptor_path, &current)?;
    }
    spawn_stdout_reader(
        child
            .stdout
            .take()
            .context("worker stdout was unavailable")?,
        active,
        event_buffer,
        sequence,
        Arc::clone(descriptor),
        descriptor_path.to_path_buf(),
    );
    spawn_stderr_reader(
        child
            .stderr
            .take()
            .context("worker stderr was unavailable")?,
        RuntimePaths::discover()?.logs_dir,
        snapshot.worker_id,
    );
    Ok(child)
}

#[allow(clippy::too_many_arguments)]
fn authenticate_and_attach(
    stream: UnixStream,
    epoch: u64,
    expected_token: &str,
    active: ActiveWriter,
    stdin: ActiveStdin,
    event_buffer: Arc<Mutex<VecDeque<Value>>>,
    descriptor: Arc<Mutex<WorkerDescriptor>>,
    shutdown_requested: Arc<AtomicBool>,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let auth: Value = serde_json::from_str(first.trim()).context("invalid worker auth envelope")?;
    if auth.get("type").and_then(Value::as_str) != Some("worker.auth")
        || auth.get("token").and_then(Value::as_str) != Some(expected_token)
    {
        bail!("worker authentication failed")
    }
    stream.set_read_timeout(None)?;
    let snapshot = descriptor
        .lock()
        .expect("descriptor mutex poisoned")
        .clone();
    let registration = json!({
        "version": 1,
        "type": "worker.register",
        "worker_id": snapshot.worker_id,
        "agent_id": snapshot.agent_id,
        "session_id": snapshot.session_id,
        "generation": snapshot.generation,
        "status": snapshot.status,
        "pid": snapshot.pid,
        "child_pid": snapshot.child_pid
    });
    let mut registration_stream = stream.try_clone()?;
    serde_json::to_writer(&mut registration_stream, &registration)?;
    registration_stream.write_all(b"\n")?;
    registration_stream.flush()?;
    {
        let mut current = active.lock().expect("active writer mutex poisoned");
        *current = Some((epoch, stream.try_clone()?));
    }
    for event in event_buffer
        .lock()
        .expect("event buffer mutex poisoned")
        .iter()
    {
        send_active(&active, event);
    }

    thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|value| {
                    value
                        .get("method")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                == Some("shutdown")
            {
                shutdown_requested.store(true, Ordering::SeqCst);
            }
            let write_result = (|| -> Result<()> {
                let mut current = stdin.lock().expect("worker stdin mutex poisoned");
                let writer = current
                    .as_mut()
                    .context("worker is recovering and cannot accept RPC")?;
                writer.write_all(line.as_bytes())?;
                writer.write_all(b"\n")?;
                writer.flush()?;
                Ok(())
            })();
            if write_result.is_err() {
                break;
            }
        }
        let mut current = active.lock().expect("active writer mutex poisoned");
        if current
            .as_ref()
            .is_some_and(|(current_epoch, _)| *current_epoch == epoch)
        {
            *current = None;
        }
    });
    Ok(())
}

fn spawn_stdout_reader(
    stdout: impl Read + Send + 'static,
    active: ActiveWriter,
    event_buffer: Arc<Mutex<VecDeque<Value>>>,
    sequence: Arc<AtomicU64>,
    descriptor: Arc<Mutex<WorkerDescriptor>>,
    descriptor_path: PathBuf,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if kind == "ready" {
                let mut current = descriptor.lock().expect("descriptor mutex poisoned");
                if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
                    current.session_id = Some(session_id.to_owned());
                }
                current.status = "running".into();
                if let Some(object) = value.as_object_mut() {
                    object.insert("generation".into(), json!(current.generation));
                }
                let _ = write_descriptor(&descriptor_path, &current);
            }
            if matches!(kind.as_str(), "event" | "run-result") {
                let current = descriptor.lock().expect("descriptor mutex poisoned");
                let next = sequence.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(object) = value.as_object_mut() {
                    object.insert("generation".into(), json!(current.generation));
                    object.insert(
                        "cursor".into(),
                        json!({"generation": current.generation, "sequence": next}),
                    );
                }
                drop(current);
                let mut buffer = event_buffer.lock().expect("event buffer mutex poisoned");
                buffer.push_back(value.clone());
                while buffer.len() > EVENT_BUFFER_LIMIT {
                    buffer.pop_front();
                }
            }
            send_active(&active, &value);
        }
    });
}

fn spawn_stderr_reader(
    stderr: impl Read + Send + 'static,
    log_directory: PathBuf,
    worker_id: String,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0u8; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            append_log(
                &log_directory,
                &worker_id,
                &String::from_utf8_lossy(&buffer[..count]),
            );
        }
    });
}

fn send_active(active: &ActiveWriter, value: &Value) {
    let mut current = active.lock().expect("active writer mutex poisoned");
    let Some((_, stream)) = current.as_mut() else {
        return;
    };
    let result = serde_json::to_writer(&mut *stream, value)
        .and_then(|_| stream.write_all(b"\n").map_err(serde_json::Error::io))
        .and_then(|_| stream.flush().map_err(serde_json::Error::io));
    if result.is_err() {
        *current = None;
    }
}

fn append_log(directory: &Path, worker_id: &str, text: &str) {
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(format!("worker-{worker_id}.log")))
    {
        let _ = log.write_all(text.as_bytes());
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_round_trips_without_losing_identity() {
        let root = std::env::temp_dir().join(format!("dao-worker-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let paths = RuntimePaths {
            runtime_dir: root.join("run"),
            state_dir: root.join("state"),
            public_socket: root.join("run/daemon.sock"),
            daemon_lock: root.join("run/daemon.lock"),
            database: root.join("state/supervisor.sqlite"),
            workers_dir: root.join("state/workers"),
            logs_dir: root.join("state/logs"),
            client_id: root.join("state/client-id"),
        };
        paths.ensure().unwrap();
        let mut value = WorkerDescriptor::new(
            &paths,
            "worker-1".into(),
            "agent-1".into(),
            "workspace-1".into(),
            root.clone(),
            root.join("session.jsonl"),
            root.clone(),
            root.join("agent.edn"),
            "secret".into(),
        );
        value.preset_id = Some("standard".into());
        let path = paths.worker_descriptor("worker-1");
        write_descriptor(&path, &value).unwrap();
        let loaded = read_descriptor(&path).unwrap();
        assert_eq!(loaded.agent_id, "agent-1");
        assert_eq!(loaded.preset_id.as_deref(), Some("standard"));
        assert_eq!(loaded.token, "secret");
        fs::remove_dir_all(root).unwrap();
    }
}
