#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
static FAULT_TEST_LOCK: Mutex<()> = Mutex::new(());

fn daemon_binary() -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_BIN_EXE_dao"));
    if compiled.is_file() {
        return compiled;
    }

    // Cargo fingerprints can survive a repository move and leave the
    // compile-time CARGO_BIN_EXE path pointing at the old checkout. Prefer
    // the binary next to the currently running integration test in that case.
    // This also respects a caller-provided CARGO_TARGET_DIR.
    let current = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .and_then(Path::parent)
                .map(|path| path.join("dao"))
        })
        .unwrap_or_default();
    assert!(
        current.is_file(),
        "daemon test binary was not found at either {} or {}",
        compiled.display(),
        current.display()
    );
    current
}

struct Harness {
    _serial: MutexGuard<'static, ()>,
    child: Child,
    root: PathBuf,
    socket: PathBuf,
    repository: PathBuf,
    config: PathBuf,
    extra_env: Vec<(String, String)>,
}

impl Harness {
    fn start() -> Self {
        Self::start_with_config("examples/tui-mock.edn")
    }

    fn start_with_config(config: &str) -> Self {
        Self::start_with_env(config, &[])
    }

    fn start_with_env(config: &str, extra_env: &[(&str, &str)]) -> Self {
        let serial = FAULT_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .to_path_buf();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = PathBuf::from("/tmp").join(format!("df-{}", &suffix[..8]));
        let runtime = root.join("r");
        let state = root.join("s");
        let workspace = root.join("w");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let socket = runtime.join("daemon.sock");
        let config = repository.join(config);
        let extra_env: Vec<_> = extra_env
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        let binary = daemon_binary();
        let mut command = Command::new(&binary);
        command
            .arg("daemon")
            .arg("serve")
            .arg("--repository-root")
            .arg(&repository)
            .arg("--config")
            .arg(&config)
            .current_dir(&repository)
            .env("QI_AGENT_RUNTIME_DIR", &runtime)
            .env("QI_AGENT_STATE_DIR", &state)
            .env("QI_AGENT_REPOSITORY_ROOT", &repository)
            .env(
                "QI_AGENT_HOME",
                fs::canonicalize(&root).unwrap().join("home"),
            )
            .env(
                "QI_AGENT_PRESET_USER_ROOT",
                fs::canonicalize(&root).unwrap().join("presets"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        for (key, value) in &extra_env {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap_or_else(|error| {
            panic!(
                "failed to start daemon test binary {}: {error}",
                binary.display()
            )
        });
        let started = Instant::now();
        while UnixStream::connect(&socket).is_err() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("daemon exited before creating its socket: {status}");
            }
            assert!(
                started.elapsed() < PROCESS_TIMEOUT,
                "daemon socket did not become connectable"
            );
            thread::sleep(Duration::from_millis(25));
        }
        Self {
            _serial: serial,
            child,
            root,
            socket,
            repository,
            config,
            extra_env,
        }
    }

    fn workspace(&self) -> PathBuf {
        self.root.join("w")
    }

    fn kill_and_restart_daemon(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        let binary = daemon_binary();
        let mut command = Command::new(&binary);
        command
            .arg("daemon")
            .arg("serve")
            .arg("--repository-root")
            .arg(&self.repository)
            .arg("--config")
            .arg(&self.config)
            .current_dir(&self.repository)
            .env("QI_AGENT_RUNTIME_DIR", self.root.join("r"))
            .env("QI_AGENT_STATE_DIR", self.root.join("s"))
            .env("QI_AGENT_REPOSITORY_ROOT", &self.repository)
            .env(
                "QI_AGENT_HOME",
                fs::canonicalize(&self.root).unwrap().join("home"),
            )
            .env(
                "QI_AGENT_PRESET_USER_ROOT",
                fs::canonicalize(&self.root).unwrap().join("presets"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        for (key, value) in &self.extra_env {
            command.env(key, value);
        }
        self.child = command.spawn().unwrap_or_else(|error| {
            panic!(
                "failed to restart daemon test binary {}: {error}",
                binary.display()
            )
        });
        let started = Instant::now();
        loop {
            if UnixStream::connect(&self.socket).is_ok() {
                break;
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("restarted daemon exited early: {status}");
            }
            assert!(
                started.elapsed() < PROCESS_TIMEOUT,
                "restarted daemon did not accept connections"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none()
            && let Ok(mut stream) = UnixStream::connect(&self.socket)
        {
            let _ = serde_json::to_writer(
                &mut stream,
                &json!({
                    "version": 1,
                    "type": "command",
                    "request_id": "cleanup-request",
                    "client_id": "cleanup",
                    "command_id": "cleanup",
                    "agent_id": null,
                    "method": "daemon.shutdown",
                    "params": {}
                }),
            );
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut response = String::new();
            let _ = BufReader::new(stream).read_line(&mut response);
        }
        let started = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(None) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                Err(_) => break,
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn preset_list_exposes_safe_display_metadata_for_mode_selection() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "preset-list-client").unwrap();
    let presets = client.call(None, "preset.list", json!({}), None).unwrap();
    let presets = presets.as_array().unwrap();

    assert_eq!(
        presets
            .iter()
            .map(|preset| preset.get("id").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>(),
        vec!["standard", "creator"]
    );
    assert_eq!(
        presets[0].get("name").and_then(Value::as_str),
        Some("标准模式")
    );
    assert_eq!(
        presets[1].get("name").and_then(Value::as_str),
        Some("创造模式")
    );
    assert!(presets.iter().all(|preset| {
        preset.get("description").and_then(Value::as_str).is_some()
            && preset.get("trust").and_then(Value::as_str) == Some("system")
            && preset.get("broken").is_none()
            && preset.get("directory").is_none()
            && preset.get("config_path").is_none()
    }));
}

#[test]
fn preset_list_marks_broken_user_entries_without_exposing_registry_details() {
    let root = PathBuf::from("/tmp").join(format!(
        "qi-agent-preset-list-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    let broken = root.join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("preset.edn"), "{:name \"Broken local mode\"}").unwrap();
    fs::write(broken.join("agent.edn"), "{:plugins [").unwrap();

    let harness = Harness::start_with_env(
        "examples/tui-mock.edn",
        &[("QI_AGENT_PRESET_USER_ROOT", root.to_str().unwrap())],
    );
    let mut client = TestClient::connect(&harness.socket, "broken-preset-list-client").unwrap();
    let presets = client.call(None, "preset.list", json!({}), None).unwrap();
    let entry = presets
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset.get("id").and_then(Value::as_str) == Some("broken"))
        .unwrap();
    assert_eq!(entry.get("broken"), Some(&Value::Bool(true)));
    assert!(entry.get("directory").is_none());
    assert!(entry.get("config_path").is_none());
    assert!(!entry.to_string().contains(root.to_string_lossy().as_ref()));

    drop(client);
    drop(harness);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn creator_and_standard_sessions_are_isolated_and_survive_restart() {
    let mut harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "creator-isolation-client").unwrap();
    let workspace = harness.workspace();
    let standard = client
        .call(
            None,
            "agent.create",
            json!({"workspace": workspace, "preset_id": "standard"}),
            Some("create-standard-profile"),
        )
        .unwrap();
    let creator = client
        .call(
            None,
            "agent.create",
            json!({"workspace": workspace, "preset_id": "creator"}),
            Some("create-creator-profile"),
        )
        .unwrap();

    let standard_id = standard
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap();
    let creator_id = creator
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap();
    assert_ne!(standard_id, creator_id);
    let standard_snapshot = PathBuf::from(
        standard
            .pointer("/agent/config_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let creator_snapshot = PathBuf::from(
        creator
            .pointer("/agent/config_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    assert_ne!(standard_snapshot, creator_snapshot);
    assert!(
        !fs::read_to_string(&standard_snapshot)
            .unwrap()
            .contains("qi.plugins.runtime-inspect")
    );
    assert!(
        fs::read_to_string(&creator_snapshot)
            .unwrap()
            .contains("qi.plugins.runtime-inspect")
    );

    drop(client);
    harness.kill_and_restart_daemon();
    let mut restarted = TestClient::connect(&harness.socket, "creator-restart-client").unwrap();
    let agents = restarted.call(None, "agent.list", json!({}), None).unwrap();
    for (id, preset_id, snapshot) in [
        (standard_id, "standard", &standard_snapshot),
        (creator_id, "creator", &creator_snapshot),
    ] {
        assert!(agents.as_array().unwrap().iter().any(|agent| {
            agent.get("agent_id").and_then(Value::as_str) == Some(id)
                && agent.get("preset_id").and_then(Value::as_str) == Some(preset_id)
                && agent.get("config_path").and_then(Value::as_str)
                    == Some(snapshot.to_string_lossy().as_ref())
        }));
    }
}

#[test]
fn agent_create_resolves_and_persists_a_preset_id() {
    let mut harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "preset-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({
                "workspace": harness.workspace(),
                "preset_id": "standard",
                "repl_backend": "babashka",
            }),
            Some("create-with-preset"),
        )
        .unwrap();

    assert_eq!(
        created.pointer("/agent/preset_id").and_then(Value::as_str),
        Some("standard")
    );
    let snapshot_config = PathBuf::from(
        created
            .pointer("/agent/config_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    assert!(snapshot_config.starts_with(fs::canonicalize(harness.root.join("s/workers")).unwrap()));
    assert!(snapshot_config.is_file());
    assert!(
        fs::read_to_string(&snapshot_config)
            .unwrap()
            .contains(":plugins")
    );

    harness.kill_and_restart_daemon();
    let mut restarted = TestClient::connect(&harness.socket, "preset-restart-client").unwrap();
    let agents = restarted.call(None, "agent.list", json!({}), None).unwrap();
    assert!(agents.as_array().unwrap().iter().any(|agent| {
        agent.get("preset_id").and_then(Value::as_str) == Some("standard")
            && agent.get("config_path").and_then(Value::as_str)
                == Some(snapshot_config.to_string_lossy().as_ref())
    }));
}

#[test]
fn user_preset_is_snapshotted_before_the_agent_starts() {
    let suffix = Uuid::new_v4().simple().to_string();
    let home = PathBuf::from("/tmp").join(format!("qi-agent-preset-home-{}", &suffix[..8]));
    let preset = home.join(".qi-agent/presets/custom");
    fs::create_dir_all(&preset).unwrap();
    fs::write(preset.join("preset.edn"), "{:name \"Custom\"}").unwrap();
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf();
    let original = fs::read_to_string(repository.join("presets/standard/agent.edn")).unwrap();
    fs::write(preset.join("agent.edn"), &original).unwrap();

    let harness = Harness::start_with_env(
        "examples/tui-mock.edn",
        &[(
            "QI_AGENT_PRESET_USER_ROOT",
            preset.parent().unwrap().to_str().unwrap(),
        )],
    );
    let mut client = TestClient::connect(&harness.socket, "user-preset-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace_path": harness.root.join("user-preset-workspace"), "preset_id": "custom"}),
            Some("create-user-preset"),
        )
        .unwrap();
    let snapshot = PathBuf::from(
        created
            .pointer("/agent/config_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let snapshotted = fs::read_to_string(&snapshot).unwrap();
    assert_eq!(
        fs::metadata(&snapshot).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(preset.join("agent.edn"), "{:plugins [false]}").unwrap();
    assert_eq!(fs::read_to_string(&snapshot).unwrap(), snapshotted);
    assert_ne!(
        snapshotted,
        fs::read_to_string(preset.join("agent.edn")).unwrap()
    );
    let rejected = client
        .call(
            None,
            "agent.create",
            json!({"workspace_path": harness.root.join("invalid-user-preset-workspace"), "preset_id": "custom"}),
            Some("reject-invalid-user-preset"),
        )
        .unwrap_err();
    assert_eq!(
        rejected.pointer("/data/type"),
        Some(&json!("preset_validation_failed"))
    );

    drop(client);
    drop(harness);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_create_rejects_arbitrary_config_paths() {
    let harness = Harness::start();
    let alternate_config = harness.repository.join("examples/daemon-goal-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "unsafe-config-client").unwrap();
    let error = client
        .call(
            None,
            "agent.create",
            json!({
                "workspace": harness.workspace(),
                "config_path": alternate_config,
            }),
            Some("reject-arbitrary-config"),
        )
        .unwrap_err();
    assert!(
        error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("preset_id"))
    );
    assert_eq!(
        error.pointer("/data/type"),
        Some(&json!("config_path_not_allowed"))
    );
}

#[test]
fn agent_create_rejects_invalid_and_unknown_preset_ids() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "invalid-preset-client").unwrap();
    for (command_id, preset_id, expected_type) in [
        ("reject-traversal-preset", "../agent", "invalid_preset_id"),
        ("reject-unknown-preset", "not-installed", "unknown_preset"),
    ] {
        let error = client
            .call(
                None,
                "agent.create",
                json!({"workspace": harness.workspace(), "preset_id": preset_id}),
                Some(command_id),
            )
            .unwrap_err();
        assert!(
            error.pointer("/data/type").and_then(Value::as_str) == Some(expected_type),
            "unexpected error: {error}"
        );
    }
    let type_error = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace(), "preset_id": 42}),
            Some("reject-non-string-preset"),
        )
        .unwrap_err();
    assert!(
        type_error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("must be a string"))
    );
    assert_eq!(
        type_error.pointer("/data/type"),
        Some(&json!("invalid_preset_id_type"))
    );
}

struct TestClient {
    reader: BufReader<UnixStream>,
    writer: BufWriter<UnixStream>,
    client_id: String,
    counter: u64,
}

impl TestClient {
    fn connect(socket: &Path, client_id: &str) -> std::io::Result<Self> {
        let stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(CLIENT_TIMEOUT))?;
        Ok(Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: BufWriter::new(stream),
            client_id: client_id.into(),
            counter: 0,
        })
    }

    fn call(
        &mut self,
        agent_id: Option<&str>,
        method: &str,
        params: Value,
        command_id: Option<&str>,
    ) -> Result<Value, Value> {
        self.counter += 1;
        let request_id = format!("request-{}", self.counter);
        serde_json::to_writer(
            &mut self.writer,
            &json!({
                "version": 1,
                "type": "command",
                "request_id": request_id,
                "client_id": self.client_id,
                "command_id": command_id,
                "agent_id": agent_id,
                "method": method,
                "params": params
            }),
        )
        .unwrap();
        self.writer.write_all(b"\n").unwrap();
        self.writer.flush().unwrap();
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line).unwrap_or_else(|error| {
                panic!("daemon read failed while waiting for {method}: {error}")
            });
            assert_ne!(
                read, 0,
                "daemon connection reached EOF while waiting for {method}"
            );
            let envelope: Value = serde_json::from_str(&line).unwrap();
            if envelope.get("type").and_then(Value::as_str) == Some("response")
                && envelope.get("id").and_then(Value::as_str) == Some(&request_id)
            {
                return if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(envelope.get("error").cloned().unwrap_or(Value::Null))
                };
            }
        }
    }
}

#[test]
fn idle_worker_is_passivated_without_deleting_session_and_hydrates_on_attach() {
    let harness = Harness::start_with_env(
        "examples/tui-mock.edn",
        &[("QI_AGENT_IDLE_EVICTION_MINUTES", "0.001")],
    );
    let mut client = TestClient::connect(&harness.socket, "idle-lifecycle-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-idle-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let session_id = created
        .pointer("/snapshot/session_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let session_path = PathBuf::from(
        created
            .pointer("/agent/session_path")
            .and_then(Value::as_str)
            .unwrap(),
    );
    let generation = created
        .pointer("/snapshot/generation")
        .and_then(Value::as_u64)
        .unwrap();

    thread::sleep(Duration::from_millis(150));
    let update = client
        .call(None, "daemon.update", json!({}), Some("sweep-idle-agent"))
        .unwrap();
    assert!(
        update
            .get("idle_sweep")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|entry| entry.get("evicted") == Some(&Value::Bool(true)))
    );
    assert!(session_path.is_file(), "idle eviction deleted the session");
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    let inactive = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent.get("agent_id").and_then(Value::as_str) == Some(&agent_id))
        .unwrap();
    assert_eq!(inactive.get("status"), Some(&json!("inactive")));
    assert_eq!(inactive.get("residency"), Some(&json!("inactive")));

    let attached = client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    assert_eq!(
        attached.pointer("/snapshot/session_id"),
        Some(&json!(session_id))
    );
    assert!(
        attached
            .pointer("/snapshot/generation")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > generation)
    );
    assert_eq!(
        attached.pointer("/agent/residency"),
        Some(&json!("resident"))
    );
}

#[test]
fn active_schedule_pins_otherwise_idle_worker() {
    let harness = Harness::start_with_env(
        "examples/daemon-goal-mock.edn",
        &[("QI_AGENT_IDLE_EVICTION_MINUTES", "0.001")],
    );
    let mut client = TestClient::connect(&harness.socket, "schedule-pin-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-schedule-pin-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "schedule.add",
            json!({"prompt": "run much later", "delay_ms": 60_000}),
            Some("add-schedule-pin"),
        )
        .unwrap();
    client
        .call(Some(&agent_id), "agent.detach", json!({}), None)
        .unwrap();
    thread::sleep(Duration::from_millis(150));
    let update = client
        .call(None, "daemon.update", json!({}), Some("sweep-schedule-pin"))
        .unwrap();
    let outcome = update
        .get("idle_sweep")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .unwrap();
    assert_eq!(outcome.get("evicted"), Some(&Value::Bool(false)));
    assert!(
        outcome
            .get("idle_pin_reasons")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|reason| reason
                .as_str()
                .is_some_and(|value| value.starts_with("schedule:")))
    );
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    let agent = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent.get("agent_id").and_then(Value::as_str) == Some(&agent_id))
        .unwrap();
    assert_eq!(agent.get("residency"), Some(&json!("resident")));
}

#[test]
fn controller_is_exclusive_and_command_retry_is_idempotent() {
    let harness = Harness::start();
    let mut first = TestClient::connect(&harness.socket, "client-one").unwrap();
    let created = first
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let first_attach = first
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    assert_eq!(first_attach.get("controller"), Some(&Value::Bool(true)));

    let mut second = TestClient::connect(&harness.socket, "client-two").unwrap();
    let second_attach = second
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    assert_eq!(second_attach.get("controller"), Some(&Value::Bool(false)));
    let observer_error = second
        .call(
            Some(&agent_id),
            "turn.submit",
            json!({"message": "must not run"}),
            Some("observer-submit"),
        )
        .unwrap_err();
    assert!(
        observer_error
            .get("message")
            .and_then(Value::as_str)
            .unwrap()
            .contains("observer")
    );

    second
        .call(
            Some(&agent_id),
            "agent.take_control",
            json!({}),
            Some("take-control"),
        )
        .unwrap();
    let first_result = second
        .call(
            Some(&agent_id),
            "turn.submit",
            json!({"message": "idempotent prompt"}),
            Some("submit-once"),
        )
        .unwrap();
    let replayed = second
        .call(
            Some(&agent_id),
            "turn.submit",
            json!({"message": "idempotent prompt"}),
            Some("submit-once"),
        )
        .unwrap();
    assert_eq!(first_result, replayed);
    assert!(
        first
            .call(
                Some(&agent_id),
                "turn.submit",
                json!({"message": "old controller must not run"}),
                Some("old-controller-submit"),
            )
            .is_err()
    );

    thread::sleep(Duration::from_millis(400));
    let snapshot = second
        .call(Some(&agent_id), "session.snapshot", json!({}), None)
        .unwrap();
    let matching_user_messages = snapshot
        .get("events")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter(|event| {
            event.pointer("/data/message/role").and_then(Value::as_str) == Some("user")
                && event
                    .pointer("/data/message/content")
                    .and_then(Value::as_str)
                    == Some("idempotent prompt")
        })
        .count();
    assert_eq!(matching_user_messages, 1);

    second
        .call(Some(&agent_id), "agent.stop", json!({}), Some("stop-agent"))
        .unwrap();
    second
        .call(None, "daemon.shutdown", json!({}), Some("shutdown"))
        .unwrap();
}

#[test]
fn settings_mutations_require_controller_and_are_journaled() {
    let root = PathBuf::from("/tmp").join(format!(
        "qi-authority-{}",
        &Uuid::new_v4().simple().to_string()[..8]
    ));
    fs::create_dir_all(&root).unwrap();
    let config = root.join("settings.edn");
    fs::write(
        &config,
        r#"{:plugins [{:ns qi.plugins.session}
      {:ns qi.plugins.model-registry} {:ns qi.plugins.auth-store}
      {:ns qi.plugins.provider-settings} {:ns qi.plugins.remote-registry}
      {:ns qi.plugins.approval :config {:mode :deny}}
      {:ns qi.plugins.runtime} {:ns qi.plugins.remote-api}]}"#,
    )
    .unwrap();
    let settings = root.join("providers.json");
    fs::write(
        &settings,
        json!({"version":1,"providers":[{"id":"review",
      "protocol":"openai-completions","baseUrl":"https://example.invalid/v1",
      "models":[{"id":"mock","thinkingLevels":["low","high"],"defaultThinkingLevel":"low"}]}]})
        .to_string(),
    )
    .unwrap();
    let harness = Harness::start_with_env(
        config.to_str().unwrap(),
        &[(
            "QI_AGENT_PROVIDER_SETTINGS_FILE",
            settings.to_str().unwrap(),
        )],
    );
    let mut owner = TestClient::connect(&harness.socket, "settings-owner").unwrap();
    let created = owner
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("create"),
        )
        .unwrap();
    let agent = created["agent"]["agent_id"].as_str().unwrap();
    owner
        .call(Some(agent), "agent.attach", json!({}), None)
        .unwrap();
    let mut observer = TestClient::connect(&harness.socket, "settings-observer").unwrap();
    assert_eq!(
        observer
            .call(Some(agent), "agent.attach", json!({}), None)
            .unwrap()["controller"],
        false
    );
    for (method, params) in [
        ("policy.select", json!({"mode":"allow"})),
        ("model.thinking.select", json!({"level":"high"})),
        ("provider.settings.reload", json!({})),
    ] {
        let denied = observer
            .call(Some(agent), method, params.clone(), Some(method))
            .unwrap_err();
        assert!(denied["message"].as_str().unwrap().contains("observer"));
        owner
            .call(Some(agent), method, params, Some(method))
            .unwrap();
        let status = owner
            .call(None, "command.status", json!({"command_id":method}), None)
            .unwrap();
        assert_eq!(status["status"], "completed");
        assert_eq!(
            observer
                .call(None, "command.status", json!({"command_id":method}), None)
                .unwrap()["status"],
            "failed"
        );
    }
    let denied = observer
        .call(
            Some(agent),
            "plugin.unreviewed-write",
            json!({}),
            Some("unknown"),
        )
        .unwrap_err();
    assert!(denied["message"].as_str().unwrap().contains("observer"));
    assert_eq!(
        owner
            .call(Some(agent), "policy.status", json!({}), None)
            .unwrap()["mode"],
        "allow"
    );
    assert_eq!(
        owner
            .call(Some(agent), "model.list", json!({}), None)
            .unwrap()["current"]["thinking-level"],
        "high"
    );
    drop(observer);
    drop(owner);
    drop(harness);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_child_is_listed_attachable_and_has_its_own_repl() {
    let harness = Harness::start_with_config("examples/daemon-subagent-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "child-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-root"),
        )
        .unwrap();
    let root_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&root_id),
            "agent.attach",
            json!({"agent_id": root_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&root_id),
            "turn.submit",
            json!({"message": "spawn the child"}),
            Some("spawn-child-turn"),
        )
        .unwrap();

    let started = Instant::now();
    let child_id = loop {
        let agents = client.call(None, "agent.list", json!({}), None).unwrap();
        if let Some(child) = agents
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent.get("is_child") == Some(&Value::Bool(true)))
        {
            break child
                .get("agent_id")
                .and_then(Value::as_str)
                .unwrap()
                .to_owned();
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    };

    let attached = client
        .call(
            Some(&child_id),
            "agent.attach",
            json!({"agent_id": child_id}),
            None,
        )
        .unwrap();
    assert_eq!(attached.pointer("/agent/is_child"), Some(&json!(true)));
    assert_eq!(
        attached.pointer("/snapshot/agent_id"),
        Some(&json!(child_id))
    );
    let repl = client
        .call(
            Some(&child_id),
            "repl.eval",
            json!({"code": "(def child-only 88)", "replay_safe": false}),
            Some("child-repl-definition"),
        )
        .unwrap();
    assert_eq!(repl.get("ok"), Some(&json!(true)));
    assert!(
        repl.get("namespace")
            .and_then(Value::as_str)
            .unwrap()
            .contains(&child_id)
    );

    client
        .call(
            Some(&root_id),
            "agent.message.send",
            json!({"to": child_id, "message": "follow up after completion"}),
            Some("message-child"),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(300));
    let child_snapshot = client
        .call(Some(&child_id), "session.snapshot", json!({}), None)
        .unwrap();
    assert!(
        child_snapshot
            .get("events")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(
                |event| event.pointer("/data/message").and_then(Value::as_str)
                    == Some("follow up after completion")
            )
    );

    client
        .call(Some(&root_id), "agent.stop", json!({}), Some("stop-root"))
        .unwrap();
    client
        .call(
            None,
            "daemon.shutdown",
            json!({}),
            Some("shutdown-child-test"),
        )
        .unwrap();
}

#[test]
fn idle_retained_child_passivates_and_hydrates_on_demand() {
    let harness = Harness::start_with_env(
        "examples/daemon-subagent-mock.edn",
        &[("QI_AGENT_IDLE_EVICTION_MINUTES", "0.001")],
    );
    let mut client = TestClient::connect(&harness.socket, "child-idle-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-child-idle-root"),
        )
        .unwrap();
    let root_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&root_id),
            "agent.attach",
            json!({"agent_id": root_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&root_id),
            "turn.submit",
            json!({"message": "spawn the child"}),
            Some("spawn-idle-child"),
        )
        .unwrap();
    let started = Instant::now();
    let child_id = loop {
        let agents = client.call(None, "agent.list", json!({}), None).unwrap();
        if let Some(child) = agents.as_array().unwrap().iter().find(|agent| {
            agent.get("is_child") == Some(&Value::Bool(true))
                && agent.get("status") == Some(&json!("completed"))
        }) {
            break child
                .get("agent_id")
                .and_then(Value::as_str)
                .unwrap()
                .to_owned();
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    };

    thread::sleep(Duration::from_millis(150));
    let update = client
        .call(
            None,
            "daemon.update",
            json!({}),
            Some("passivate-idle-child"),
        )
        .unwrap();
    assert!(
        update
            .get("idle_sweep")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .flat_map(|entry| {
                entry
                    .get("child_passivations")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .any(|entry| entry.get("agent_id").and_then(Value::as_str) == Some(&child_id))
    );
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    let passive = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent.get("agent_id").and_then(Value::as_str) == Some(&child_id))
        .unwrap();
    assert_eq!(passive.get("status"), Some(&json!("inactive")));
    assert_eq!(passive.get("residency"), Some(&json!("inactive")));

    let attached = client
        .call(
            Some(&child_id),
            "agent.attach",
            json!({"agent_id": child_id}),
            None,
        )
        .unwrap();
    assert_eq!(
        attached.pointer("/snapshot/agent_id"),
        Some(&json!(child_id))
    );
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    let hydrated = agents
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent.get("agent_id").and_then(Value::as_str) == Some(&child_id))
        .unwrap();
    assert_eq!(hydrated.get("residency"), Some(&json!("resident")));
}

#[test]
fn cross_root_message_is_durable_before_ack_and_deduplicated() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "message-client").unwrap();
    let first = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace(), "name": "sender"}),
            Some("create-sender"),
        )
        .unwrap();
    let second = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace(), "name": "receiver"}),
            Some("create-receiver"),
        )
        .unwrap();
    let sender = first.pointer("/agent/agent_id").unwrap().as_str().unwrap();
    let receiver = second.pointer("/agent/agent_id").unwrap().as_str().unwrap();
    client
        .call(
            Some(sender),
            "agent.attach",
            json!({"agent_id": sender}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(receiver),
            "agent.attach",
            json!({"agent_id": receiver}),
            None,
        )
        .unwrap();

    let delivered = client
        .call(
            Some(sender),
            "agent.message.send",
            json!({"to": receiver, "message": "durable cross-root hello"}),
            Some("cross-root-message"),
        )
        .unwrap();
    assert_eq!(delivered.get("accepted"), Some(&json!(true)));
    assert_eq!(delivered.pointer("/delivery/accepted"), Some(&json!(true)));
    let replayed = client
        .call(
            Some(sender),
            "agent.message.send",
            json!({"to": receiver, "message": "durable cross-root hello"}),
            Some("cross-root-message"),
        )
        .unwrap();
    assert_eq!(delivered, replayed);

    let receiver_snapshot = client
        .call(Some(receiver), "session.snapshot", json!({}), None)
        .unwrap();
    let received: Vec<_> = receiver_snapshot
        .get("events")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("agent/message/received")
                && event.pointer("/data/message").and_then(Value::as_str)
                    == Some("durable cross-root hello")
        })
        .collect();
    assert_eq!(received.len(), 1);
    assert_eq!(
        received[0].pointer("/data/from").and_then(Value::as_str),
        Some(sender)
    );
    assert_eq!(
        received[0]
            .pointer("/data/message_id")
            .and_then(Value::as_str),
        delivered.get("message_id").and_then(Value::as_str)
    );

    let sender_snapshot = client
        .call(Some(sender), "session.snapshot", json!({}), None)
        .unwrap();
    assert!(
        sender_snapshot
            .get("events")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|event| {
                event.get("type").and_then(Value::as_str) == Some("agent/message/sent")
                    && event.pointer("/data/to").and_then(Value::as_str) == Some(receiver)
            })
    );

    client
        .call(
            None,
            "daemon.shutdown",
            json!({}),
            Some("shutdown-message-test"),
        )
        .unwrap();
}

#[test]
fn worker_crash_increments_generation_and_restores_only_durable_repl_state() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "recovery-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-recovery-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(def crash-safe 41)", "replay_safe": true}),
            Some("safe-definition"),
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(def transient-definition 9)", "replay_safe": false}),
            Some("transient-definition"),
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "state.put",
            json!({"key": "checkpoint", "value": {"step": 3}}),
            Some("durable-checkpoint"),
        )
        .unwrap();

    let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
    let child_pid = doctor
        .pointer("/workers/0/child_pid")
        .and_then(Value::as_u64)
        .unwrap();
    assert!(
        Command::new("kill")
            .arg("-9")
            .arg(child_pid.to_string())
            .status()
            .unwrap()
            .success()
    );

    let started = Instant::now();
    loop {
        let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
        let generation = doctor
            .pointer("/workers/0/generation")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let status = doctor
            .pointer("/workers/0/status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if generation > 1 && status == "idle" {
            break;
        }
        assert!(
            started.elapsed() < PROCESS_TIMEOUT,
            "worker did not recover: {doctor}"
        );
        thread::sleep(Duration::from_millis(50));
    }

    let safe = client
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(+ crash-safe 1)"}),
            Some("verify-safe-definition"),
        )
        .unwrap();
    assert_eq!(safe.get("value"), Some(&json!("42")));
    let transient = client
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "transient-definition"}),
            Some("verify-transient-definition"),
        )
        .unwrap();
    assert_eq!(transient.get("ok"), Some(&json!(false)));
    let checkpoint = client
        .call(
            Some(&agent_id),
            "state.get",
            json!({"key": "checkpoint"}),
            None,
        )
        .unwrap();
    assert_eq!(checkpoint.pointer("/value/step"), Some(&json!(3)));

    client
        .call(
            None,
            "daemon.shutdown",
            json!({}),
            Some("shutdown-recovery-test"),
        )
        .unwrap();
}

#[test]
fn daemon_crash_adopts_the_same_worker_and_preserves_live_repl() {
    let mut harness = Harness::start();
    let mut first = TestClient::connect(&harness.socket, "before-daemon-crash").unwrap();
    let created = first
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-adoption-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    first
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    first
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(def daemon-survivor 73)", "replay_safe": false}),
            Some("define-daemon-survivor"),
        )
        .unwrap();
    let before = first.call(None, "daemon.doctor", json!({}), None).unwrap();
    let proxy_pid = before
        .pointer("/workers/0/pid")
        .and_then(Value::as_u64)
        .unwrap();
    let child_pid = before
        .pointer("/workers/0/child_pid")
        .and_then(Value::as_u64)
        .unwrap();
    drop(first);

    harness.kill_and_restart_daemon();
    assert!(
        Command::new("kill")
            .arg("-0")
            .arg(proxy_pid.to_string())
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("kill")
            .arg("-0")
            .arg(child_pid.to_string())
            .status()
            .unwrap()
            .success()
    );

    let mut second = TestClient::connect(&harness.socket, "after-daemon-crash").unwrap();
    let attached = second
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    assert_eq!(attached.pointer("/snapshot/generation"), Some(&json!(1)));
    second
        .call(
            Some(&agent_id),
            "agent.take_control",
            json!({}),
            Some("take-control-after-adoption"),
        )
        .unwrap();
    let repl = second
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "daemon-survivor"}),
            Some("read-daemon-survivor"),
        )
        .unwrap();
    assert_eq!(repl.get("value"), Some(&json!("73")));
    let after = second.call(None, "daemon.doctor", json!({}), None).unwrap();
    assert_eq!(after.pointer("/workers/0/pid"), Some(&json!(proxy_pid)));
    assert_eq!(
        after.pointer("/workers/0/child_pid"),
        Some(&json!(child_pid))
    );

    second
        .call(
            None,
            "daemon.shutdown",
            json!({}),
            Some("shutdown-adoption-test"),
        )
        .unwrap();
}

#[test]
fn mutation_interrupted_by_worker_crash_remains_uncertain_and_is_not_replayed() {
    let harness = Harness::start();
    let mut controller = TestClient::connect(&harness.socket, "uncertain-client").unwrap();
    let created = controller
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-uncertain-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    controller
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    let doctor = controller
        .call(None, "daemon.doctor", json!({}), None)
        .unwrap();
    let child_pid = doctor
        .pointer("/workers/0/child_pid")
        .and_then(Value::as_u64)
        .unwrap();

    let socket = harness.socket.clone();
    let in_flight_agent = agent_id.clone();
    let request = thread::spawn(move || {
        let mut client = TestClient::connect(&socket, "uncertain-client").unwrap();
        client.call(
            Some(&in_flight_agent),
            "repl.eval",
            json!({"code": "(do (Thread/sleep 5000) :finished)"}),
            Some("interrupted-mutation"),
        )
    });
    thread::sleep(Duration::from_millis(250));
    assert!(
        Command::new("kill")
            .arg("-9")
            .arg(child_pid.to_string())
            .status()
            .unwrap()
            .success()
    );
    let interrupted = request.join().unwrap().unwrap_err();
    assert_eq!(
        interrupted.pointer("/data/status"),
        Some(&json!("uncertain"))
    );

    let started = Instant::now();
    loop {
        let doctor = controller
            .call(None, "daemon.doctor", json!({}), None)
            .unwrap();
        if doctor.pointer("/workers/0/generation") == Some(&json!(2))
            && doctor.pointer("/workers/0/status") == Some(&json!("idle"))
        {
            break;
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    }
    let replay = controller
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(do (Thread/sleep 5000) :finished)"}),
            Some("interrupted-mutation"),
        )
        .unwrap_err();
    assert_eq!(replay.pointer("/data/status"), Some(&json!("uncertain")));
    assert!(
        replay
            .get("message")
            .and_then(Value::as_str)
            .unwrap()
            .contains("will not be replayed")
    );

    controller
        .call(
            None,
            "daemon.shutdown",
            json!({}),
            Some("shutdown-uncertain-test"),
        )
        .unwrap();
}

#[test]
fn durable_goal_continues_only_to_its_explicit_budget() {
    let harness = Harness::start_with_config("examples/daemon-goal-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "goal-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-goal-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    let accepted = client
        .call(
            Some(&agent_id),
            "goal.set",
            json!({
                "objective": "finish the bounded goal",
                "max_continuations": 1,
            }),
            Some("set-bounded-goal"),
        )
        .unwrap();
    let goal_id = accepted
        .pointer("/goal/goal_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let started = Instant::now();
    let goal = loop {
        let goals = client
            .call(Some(&agent_id), "goal.list", json!({}), None)
            .unwrap();
        let goal = goals
            .as_array()
            .unwrap()
            .iter()
            .find(|goal| goal.get("goal_id").and_then(Value::as_str) == Some(&goal_id))
            .unwrap()
            .clone();
        if goal.get("status").and_then(Value::as_str) == Some("budget_exhausted") {
            break goal;
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(goal.get("continuation_count"), Some(&json!(1)));
    let snapshot = client
        .call(Some(&agent_id), "session.snapshot", json!({}), None)
        .unwrap();
    let assistant_messages: Vec<_> = snapshot
        .get("events")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter(|event| {
            event.pointer("/data/message/role").and_then(Value::as_str) == Some("assistant")
        })
        .collect();
    assert_eq!(assistant_messages.len(), 2);
}

#[test]
fn one_shot_schedule_survives_daemon_restart_without_a_tui() {
    let mut harness = Harness::start_with_config("examples/daemon-goal-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "schedule-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-schedule-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    let scheduled = client
        .call(
            Some(&agent_id),
            "schedule.add",
            json!({"prompt": "run after restart", "delay_ms": 800}),
            Some("add-one-shot"),
        )
        .unwrap();
    let schedule_id = scheduled
        .get("schedule_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    drop(client);
    harness.kill_and_restart_daemon();
    let mut reattached = TestClient::connect(&harness.socket, "schedule-client").unwrap();
    reattached
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    let started = Instant::now();
    loop {
        let schedules = reattached
            .call(Some(&agent_id), "schedule.list", json!({}), None)
            .unwrap();
        let status = schedules
            .as_array()
            .unwrap()
            .iter()
            .find(|schedule| {
                schedule.get("schedule_id").and_then(Value::as_str) == Some(&schedule_id)
            })
            .and_then(|schedule| schedule.get("status"))
            .and_then(Value::as_str);
        if status == Some("completed") {
            break;
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    }
    let snapshot = reattached
        .call(Some(&agent_id), "session.snapshot", json!({}), None)
        .unwrap();
    assert!(
        snapshot
            .get("events")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|event| event
                .pointer("/data/message/content")
                .and_then(Value::as_str)
                == Some("run after restart"))
    );
    let schedules = reattached
        .call(Some(&agent_id), "schedule.list", json!({}), None)
        .unwrap();
    let delivery_id = schedules
        .as_array()
        .unwrap()
        .iter()
        .find(|schedule| schedule["schedule_id"] == schedule_id)
        .unwrap()["policy"]["last_delivery_id"]
        .as_str()
        .unwrap();
    let database = rusqlite::Connection::open(harness.root.join("s/supervisor.sqlite")).unwrap();
    let count: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE run_id=?1",
            [delivery_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "schedule delivery identity was not preserved through worker admission"
    );
}

#[test]
fn stop_dead_worker_does_not_hydrate_and_releases_uncertain_lease() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "stop-dead-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-stop-dead"),
        )
        .unwrap();
    let agent_id = created["agent"]["agent_id"].as_str().unwrap();
    client
        .call(Some(agent_id), "agent.attach", json!({}), None)
        .unwrap();
    let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
    let worker = &doctor["workers"][0];
    let proxy = worker["pid"].as_u64().unwrap() as i32;
    let descriptor_path = harness
        .root
        .join("s/workers")
        .join(format!("{}.json", worker["worker_id"].as_str().unwrap()));
    let mut descriptor: Value =
        serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    let generation = descriptor["generation"].clone();
    // A stopped worker needs neither a usable model/config nor a new writer.
    // Poison only this temporary descriptor so an accidental hydration fails.
    descriptor["config_path"] = json!(harness.root.join("missing-agent.edn"));
    fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
    unsafe {
        assert_eq!(libc::kill(-proxy, libc::SIGKILL), 0);
    }
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
        if doctor["workers"][0]["alive"] == false {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    let database = rusqlite::Connection::open(harness.root.join("s/supervisor.sqlite")).unwrap();
    database
        .execute(
            "INSERT INTO leases(resource_type,resource_key,owner,expires_at_ms,uncertain_request_id) VALUES ('workspace-write',?1,?2,NULL,'stop-dead-unknown')",
            rusqlite::params![created["agent"]["workspace_id"].as_str().unwrap(), agent_id],
        )
        .unwrap();
    client
        .call(Some(agent_id), "agent.stop", json!({}), Some("stop-dead"))
        .unwrap();
    let stopped: Value = serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    assert_eq!(
        stopped["generation"], generation,
        "stop hydrated a new generation"
    );
    assert_eq!(
        stopped["pid"], descriptor["pid"],
        "stop replaced the old proxy"
    );
    let remaining: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM leases WHERE owner=?1",
            [agent_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
    let update = client
        .call(
            None,
            "daemon.update",
            json!({}),
            Some("update-after-stop-dead"),
        )
        .unwrap();
    assert_eq!(update["worker_count"], 0);
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    assert_eq!(agents[0]["status"], "stopped");
    assert_ne!(unsafe { libc::kill(-proxy, 0) }, 0);
    // Completed stops remain idempotent after ordinary descriptor cleanup.
    fs::remove_file(&descriptor_path).unwrap();
    client
        .call(
            Some(agent_id),
            "agent.take_control",
            json!({}),
            Some("retake-stopped"),
        )
        .unwrap();
    client
        .call(
            Some(agent_id),
            "agent.stop",
            json!({}),
            Some("stop-dead-again"),
        )
        .unwrap();

    // Losing process identity must not clear an unresolved writer lease.
    database.execute(
        "INSERT INTO leases(resource_type,resource_key,owner,expires_at_ms,uncertain_request_id) VALUES ('workspace-write',?1,?2,NULL,'unknown-without-descriptor')",
        rusqlite::params![created["agent"]["workspace_id"].as_str().unwrap(), agent_id],
    ).unwrap();
    client
        .call(
            Some(agent_id),
            "agent.take_control",
            json!({}),
            Some("retake-unknown"),
        )
        .unwrap();
    let error = client
        .call(
            Some(agent_id),
            "agent.stop",
            json!({}),
            Some("stop-unknown-without-identity"),
        )
        .unwrap_err();
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("cannot verify stopped worker process identity")
    );
    let retained: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM leases WHERE owner=?1",
            [agent_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1);
}

#[test]
fn killed_proxy_recovers_without_a_second_writer_or_daemon_restart() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "proxy-crash-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("create-proxy-crash"),
        )
        .unwrap();
    let agent_id = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id":agent_id}),
            None,
        )
        .unwrap();
    let before = client.call(None, "daemon.doctor", json!({}), None).unwrap();
    let proxy = before["workers"][0]["pid"].as_u64().unwrap() as i32;
    let child = before["workers"][0]["child_pid"].as_u64().unwrap() as i32;
    // Keep the old BB writer alive after proxy death; recovery must retire it.
    unsafe {
        assert_eq!(libc::kill(child, libc::SIGSTOP), 0);
        assert_eq!(libc::kill(proxy, libc::SIGKILL), 0);
    }
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
        if doctor["workers"][0]["alive"] == false {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    client
        .call(
            None,
            "daemon.update",
            json!({}),
            Some("recover-proxy-crash"),
        )
        .unwrap();
    let recovered = client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id":agent_id}),
            None,
        )
        .unwrap();
    assert!(recovered["snapshot"]["generation"].as_u64().unwrap() > 1);
    assert_ne!(
        unsafe { libc::kill(child, 0) },
        0,
        "old writer survived replacement"
    );
    let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
    assert_eq!(doctor["workers"].as_array().unwrap().len(), 1);
    assert_eq!(doctor["workers"][0]["alive"], true);
    assert_ne!(doctor["workers"][0]["pid"].as_u64().unwrap(), proxy as u64);
    // A second attach observes the same replacement rather than starting another.
    let again = client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id":agent_id}),
            None,
        )
        .unwrap();
    assert_eq!(
        again["snapshot"]["generation"],
        recovered["snapshot"]["generation"]
    );
    let proxy = doctor["workers"][0]["pid"].as_u64().unwrap() as i32;
    let child = doctor["workers"][0]["child_pid"].as_u64().unwrap() as i32;
    struct GroupCleanup(i32);
    impl Drop for GroupCleanup {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
        }
    }
    let _cleanup = GroupCleanup(proxy);
    let spawned = client.call(Some(&agent_id),"repl.eval",json!({"code":"(.pid (.start (ProcessBuilder. (into-array String [\"/bin/sleep\" \"60\"]))))"}),Some("spawn-orphan-tool")).unwrap();
    let tool_pid = spawned["value"].as_str().unwrap().parse::<i32>().unwrap();
    assert_eq!(unsafe { libc::getpgid(tool_pid) }, proxy);
    unsafe {
        assert_eq!(libc::kill(proxy, libc::SIGKILL), 0);
        assert_eq!(libc::kill(child, libc::SIGKILL), 0);
    }
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
        if doctor["workers"][0]["alive"] == false {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    // The recorded BB PID is dead, but its tool still occupies the old group.
    assert_eq!(unsafe { libc::kill(tool_pid, 0) }, 0);
    client
        .call(
            None,
            "daemon.update",
            json!({}),
            Some("recover-orphan-tool"),
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id":agent_id}),
            None,
        )
        .unwrap();
    assert_ne!(
        unsafe { libc::kill(tool_pid, 0) },
        0,
        "orphan tool survived replacement"
    );
    // Explicit stop is also the escape from an unresolved workspace delivery.
    let database = rusqlite::Connection::open(harness.root.join("s/supervisor.sqlite")).unwrap();
    database.execute("INSERT INTO leases(resource_type,resource_key,owner,expires_at_ms,uncertain_request_id) VALUES ('workspace-write',?1,?2,NULL,'unresolved-test')",
        rusqlite::params![created["agent"]["workspace_id"].as_str().unwrap(),agent_id]).unwrap();
    client
        .call(
            Some(&agent_id),
            "agent.stop",
            json!({}),
            Some("stop-uncertain-worker"),
        )
        .unwrap();
    let remaining: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM leases WHERE owner=?1",
            [&agent_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        remaining, 0,
        "explicit stop retained an unresolved lease after killing the whole worker group"
    );
}

#[test]
fn session_archive_rejects_source_target_and_writer_lock_symlinks() {
    use std::os::unix::fs::symlink;
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "archive-link-client").unwrap();
    let outside = harness.workspace().join("outside.jsonl");
    let source = harness.workspace().join("source.jsonl");
    let target = harness.workspace().join("target.jsonl");
    fs::write(&outside, b"original outside history").unwrap();
    symlink(&outside, &source).unwrap();
    assert!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":source,"archive_path":target}),
                Some("source-link")
            )
            .is_err()
    );
    assert_eq!(fs::read(&outside).unwrap(), b"original outside history");
    assert!(!target.exists());
    fs::remove_file(&source).unwrap();
    fs::write(&source, b"original session history").unwrap();
    symlink(&outside, &target).unwrap();
    assert!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":source,"archive_path":target}),
                Some("target-link")
            )
            .is_err()
    );
    fs::remove_file(&target).unwrap();
    let lock = PathBuf::from(format!("{}.writer.lock", source.display()));
    symlink(&outside, &lock).unwrap();
    assert!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":source,"archive_path":target}),
                Some("lock-link")
            )
            .is_err()
    );
    assert_eq!(fs::read(&outside).unwrap(), b"original outside history");
    assert_eq!(fs::read(&source).unwrap(), b"original session history");
    assert!(!target.exists());
}

#[test]
fn session_archive_stops_writer_updates_paths_and_is_retryable_after_restart() {
    let mut harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "archive-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("create-archive"),
        )
        .unwrap();
    let agent_id = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    let source = PathBuf::from(created["agent"]["session_path"].as_str().unwrap());
    let target = harness.workspace().join("archive/sessions/test.jsonl");
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id":agent_id}),
            None,
        )
        .unwrap();
    let mut observer = TestClient::connect(&harness.socket, "archive-observer").unwrap();
    let denied = observer
        .call(
            None,
            "session.archive",
            json!({"session_path":source,"archive_path":target}),
            Some("observer-archive"),
        )
        .unwrap_err();
    assert!(denied["message"].as_str().unwrap().contains("observer"));
    assert!(source.exists());
    assert!(!target.exists());
    let socket = harness.socket.clone();
    let in_flight_agent = agent_id.clone();
    let started_marker = harness.workspace().join("archive-run-started");
    let finished_marker = harness.workspace().join("archive-run-finished");
    let code = format!(
        "(do (spit {:?} \"started\") (Thread/sleep 30000) (spit {:?} \"finished\"))",
        started_marker.to_string_lossy(),
        finished_marker.to_string_lossy()
    );
    let in_flight = thread::spawn(move || {
        let mut client = TestClient::connect(&socket, "archive-client").unwrap();
        client.call(
            Some(&in_flight_agent),
            "repl.eval",
            json!({"code":code}),
            Some("archive-running-rpc"),
        )
    });
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    while !started_marker.exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    let before = fs::read(&source).unwrap();
    let archived = client
        .call(
            None,
            "session.archive",
            json!({"session_path":source,"archive_path":target}),
            Some("archive-first"),
        )
        .unwrap();
    assert_eq!(archived["archived"], true);
    if let Ok(result) = in_flight.join().unwrap() {
        assert_eq!(result["ok"], false, "archived evaluation must not succeed");
    }
    assert!(
        !finished_marker.exists(),
        "archived worker continued its in-flight execution"
    );
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), before);
    assert!(
        client
            .call(
                Some(&agent_id),
                "agent.attach",
                json!({"agent_id":agent_id}),
                None
            )
            .is_err()
    );
    let status = client.call(None, "daemon.status", json!({}), None).unwrap();
    assert_eq!(status["worker_count"], 0);
    assert_eq!(
        status["agents"][0]["session_path"],
        target.canonicalize().unwrap().to_string_lossy().as_ref()
    );
    assert_eq!(status["agents"][0]["lifecycle"], "archived");
    drop(client);
    harness.kill_and_restart_daemon();
    let mut client = TestClient::connect(&harness.socket, "archive-retry-client").unwrap();
    assert_eq!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":source,"archive_path":target}),
                Some("archive-retry")
            )
            .unwrap()["archived"],
        true
    );
    assert!(
        client
            .call(
                None,
                "agent.create",
                json!({"workspace":harness.workspace(),"session_path":source}),
                Some("reopen-old-path")
            )
            .is_err()
    );
    assert!(!source.exists());
    // Offline historical sessions use the same durable operation, without hydrate.
    let historical = harness.workspace().join("historical.jsonl");
    fs::write(&historical, b"{\"type\":\"session/test\"}\n").unwrap();
    let destination = harness
        .workspace()
        .join("archive/sessions/historical.jsonl");
    fs::write(&destination, b"unrelated history").unwrap();
    assert!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":historical,"archive_path":destination}),
                Some("archive-conflict")
            )
            .is_err()
    );
    assert_eq!(fs::read(&destination).unwrap(), b"unrelated history");
    assert!(historical.exists());
    fs::remove_file(&destination).unwrap();
    assert_eq!(
        client
            .call(
                None,
                "session.archive",
                json!({"session_path":historical,"archive_path":destination}),
                Some("archive-history")
            )
            .unwrap()["archived"],
        true
    );
    assert!(!historical.exists());
}

#[test]
fn client_eof_detaches_without_denying_pending_approval() {
    let harness = Harness::start_with_config("examples/daemon-approval-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "detaching-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-approval-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "turn.submit",
            json!({"message": "request the guarded write"}),
            Some("submit-approval-turn"),
        )
        .unwrap();
    let started = Instant::now();
    loop {
        let pending = client
            .call(Some(&agent_id), "interaction.list", json!({}), None)
            .unwrap();
        if pending.as_array().is_some_and(|items| !items.is_empty()) {
            break;
        }
        assert!(started.elapsed() < PROCESS_TIMEOUT);
        thread::sleep(Duration::from_millis(50));
    }
    drop(client);
    thread::sleep(Duration::from_millis(250));

    let mut replacement = TestClient::connect(&harness.socket, "detaching-client").unwrap();
    replacement
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    let pending = replacement
        .call(Some(&agent_id), "interaction.list", json!({}), None)
        .unwrap();
    let interaction_id = pending
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .expect("approval disappeared after the final client detached")
        .to_owned();
    replacement
        .call(
            Some(&agent_id),
            "interaction.resolve",
            json!({"id": interaction_id, "decision": "deny"}),
            Some("deny-after-reattach"),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(150));
    assert!(!harness.workspace().join("approval.txt").exists());
}

#[test]
fn canonical_session_path_has_only_one_resident_writer() {
    let harness = Harness::start();
    let session_path = harness.workspace().join("shared.jsonl");
    let mut client = TestClient::connect(&harness.socket, "session-lease-client").unwrap();
    let first = client
        .call(
            None,
            "agent.create",
            json!({
                "workspace": harness.workspace(),
                "session_path": session_path,
            }),
            Some("create-session-owner"),
        )
        .unwrap();
    assert!(first.pointer("/agent/agent_id").is_some());
    let second = client
        .call(
            None,
            "agent.create",
            json!({
                "workspace": harness.workspace(),
                "session_path": session_path,
            }),
            Some("create-session-contender"),
        )
        .unwrap_err();
    assert!(
        second
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("UNIQUE") || message.contains("unique"))
    );
    let agents = client.call(None, "agent.list", json!({}), None).unwrap();
    let owners = agents
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| {
            agent.get("session_path").and_then(Value::as_str)
                == Some(
                    session_path
                        .canonicalize()
                        .unwrap()
                        .to_string_lossy()
                        .as_ref(),
                )
        })
        .count();
    assert_eq!(owners, 1);
}

#[test]
fn machine_restart_recreates_missing_proxy_and_restores_durable_repl_cells() {
    let mut harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "machine-restart-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace": harness.workspace()}),
            Some("create-machine-restart-agent"),
        )
        .unwrap();
    let agent_id = created
        .pointer("/agent/agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    client
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    client
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "(def machine-safe 73)", "replay_safe": true}),
            Some("machine-safe-cell"),
        )
        .unwrap();
    let doctor = client.call(None, "daemon.doctor", json!({}), None).unwrap();
    let proxy_pid = doctor
        .pointer("/workers/0/pid")
        .and_then(Value::as_u64)
        .unwrap();
    let child_pid = doctor
        .pointer("/workers/0/child_pid")
        .and_then(Value::as_u64)
        .unwrap();
    drop(client);
    for pid in [child_pid, proxy_pid] {
        assert!(
            Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        );
    }
    harness.kill_and_restart_daemon();
    let mut replacement = TestClient::connect(&harness.socket, "machine-restart-client").unwrap();
    let attached = replacement
        .call(
            Some(&agent_id),
            "agent.attach",
            json!({"agent_id": agent_id}),
            None,
        )
        .unwrap();
    assert!(
        attached
            .pointer("/snapshot/generation")
            .and_then(Value::as_u64)
            .is_some_and(|generation| generation > 1)
    );
    let evaluated = replacement
        .call(
            Some(&agent_id),
            "repl.eval",
            json!({"code": "machine-safe", "replay_safe": false}),
            Some("read-machine-safe-cell"),
        )
        .unwrap();
    assert_eq!(evaluated.get("value"), Some(&json!("73")));
}

#[test]
fn long_rpc_can_be_interrupted_on_the_same_connection_and_from_another_connection() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "interrupt-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("interrupt-create"),
        )
        .unwrap();
    let id = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    client
        .call(Some(&id), "agent.attach", json!({}), None)
        .unwrap();
    for same_connection in [true, false] {
        let marker = harness
            .workspace()
            .join(format!("started-{same_connection}"));
        let completed = harness
            .workspace()
            .join(format!("completed-{same_connection}"));
        let code = format!(
            "(do (spit {:?} \"started\") (Thread/sleep 4000) (spit {:?} \"finished\"))",
            marker, completed
        );
        let command = json!({"version":1,"type":"command","request_id":format!("eval-{same_connection}"),
            "client_id":"interrupt-client","command_id":format!("eval-{same_connection}"),"agent_id":id,
            "method":"repl.eval","params":{"code":code}});
        serde_json::to_writer(&mut client.writer, &command).unwrap();
        client.writer.write_all(b"\n").unwrap();
        client.writer.flush().unwrap();
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        while !marker.exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let started = Instant::now();
        let interrupted = if same_connection {
            client.call(
                Some(&id),
                "repl.interrupt",
                json!({}),
                Some("interrupt-same"),
            )
        } else {
            let mut other = TestClient::connect(&harness.socket, "interrupt-client").unwrap();
            // Discovery must remain available while this worker has a long RPC.
            assert!(other.call(None, "agent.list", json!({}), None).is_ok());
            other.call(
                Some(&id),
                "repl.interrupt",
                json!({}),
                Some("interrupt-other"),
            )
        }
        .unwrap();
        assert_eq!(interrupted["interrupted"], true);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!completed.exists());
        assert!(
            client
                .call(
                    Some(&id),
                    "repl.eval",
                    json!({"code":"(+ 1 2)"}),
                    Some(if same_connection {
                        "after-same"
                    } else {
                        "after-other"
                    })
                )
                .is_ok()
        );
    }
}

#[test]
fn stop_interrupts_a_long_rpc_on_its_existing_connection() {
    let harness = Harness::start();
    let mut client = TestClient::connect(&harness.socket, "stop-rpc-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("stop-create"),
        )
        .unwrap();
    let id = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    client
        .call(Some(&id), "agent.attach", json!({}), None)
        .unwrap();
    let started_marker = harness.workspace().join("stop-started");
    let finished_marker = harness.workspace().join("stop-finished");
    let code = format!(
        "(do (spit {:?} \"started\") (Thread/sleep 4000) (spit {:?} \"finished\"))",
        started_marker, finished_marker
    );
    serde_json::to_writer(
        &mut client.writer,
        &json!({"version":1,"type":"command","request_id":"stop-long-eval",
        "client_id":"stop-rpc-client","command_id":"stop-long-eval","agent_id":id,
        "method":"repl.eval","params":{"code":code}}),
    )
    .unwrap();
    client.writer.write_all(b"\n").unwrap();
    client.writer.flush().unwrap();
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    while !started_marker.exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let start = Instant::now();
    client
        .call(Some(&id), "agent.stop", json!({}), Some("stop-active-rpc"))
        .unwrap();
    assert!(start.elapsed() < Duration::from_millis(3500));
    assert!(!finished_marker.exists());
    assert!(
        client
            .call(
                Some(&id),
                "repl.eval",
                json!({"code":"(+ 1 2)"}),
                Some("stopped-eval")
            )
            .is_err()
    );
}

#[test]
fn retained_child_repl_interrupt_bypasses_its_long_rpc() {
    let harness = Harness::start_with_config("examples/daemon-subagent-mock.edn");
    let mut client = TestClient::connect(&harness.socket, "child-interrupt-client").unwrap();
    let created = client
        .call(
            None,
            "agent.create",
            json!({"workspace":harness.workspace()}),
            Some("child-interrupt-create"),
        )
        .unwrap();
    let root = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    client
        .call(Some(&root), "agent.attach", json!({}), None)
        .unwrap();
    client
        .call(
            Some(&root),
            "turn.submit",
            json!({"message":"spawn the child"}),
            Some("spawn-interrupt-child"),
        )
        .unwrap();
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    let child = loop {
        let agents = client.call(None, "agent.list", json!({}), None).unwrap();
        if let Some(child) = agents
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent["is_child"] == true)
        {
            break child["agent_id"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    };
    let marker = harness.workspace().join("child-started");
    let finished = harness.workspace().join("child-finished");
    let code = format!(
        "(do (spit {:?} \"started\") (Thread/sleep 4000) (spit {:?} \"finished\"))",
        marker, finished
    );
    serde_json::to_writer(
        &mut client.writer,
        &json!({"version":1,"type":"command","request_id":"child-long-eval",
        "client_id":"child-interrupt-client","command_id":"child-long-eval","agent_id":child,
        "method":"repl.eval","params":{"code":code}}),
    )
    .unwrap();
    client.writer.write_all(b"\n").unwrap();
    client.writer.flush().unwrap();
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    while !marker.exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let started = Instant::now();
    let interrupted = client
        .call(
            Some(&child),
            "repl.interrupt",
            json!({}),
            Some("child-interrupt"),
        )
        .unwrap();
    assert_eq!(interrupted["interrupted"], true);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!finished.exists());
}
