#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    os::unix::net::UnixStream,
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

struct Harness {
    _serial: MutexGuard<'static, ()>,
    child: Child,
    root: PathBuf,
    socket: PathBuf,
    repository: PathBuf,
    config: PathBuf,
}

impl Harness {
    fn start() -> Self {
        Self::start_with_config("examples/tui-mock.edn")
    }

    fn start_with_config(config: &str) -> Self {
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_dao"))
            .arg("daemon")
            .arg("serve")
            .arg("--repository-root")
            .arg(&repository)
            .arg("--config")
            .arg(&config)
            .current_dir(&repository)
            .env("DAO_RUNTIME_DIR", &runtime)
            .env("DAO_STATE_DIR", &state)
            .env("DAO_REPOSITORY_ROOT", &repository)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !socket.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("daemon exited before creating its socket: {status}");
            }
            assert!(
                started.elapsed() < PROCESS_TIMEOUT,
                "daemon socket did not appear"
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
        }
    }

    fn workspace(&self) -> PathBuf {
        self.root.join("w")
    }

    fn kill_and_restart_daemon(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        self.child = Command::new(env!("CARGO_BIN_EXE_dao"))
            .arg("daemon")
            .arg("serve")
            .arg("--repository-root")
            .arg(&self.repository)
            .arg("--config")
            .arg(&self.config)
            .current_dir(&self.repository)
            .env("DAO_RUNTIME_DIR", self.root.join("r"))
            .env("DAO_STATE_DIR", self.root.join("s"))
            .env("DAO_REPOSITORY_ROOT", &self.repository)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
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
        if let Ok(mut connection) = TestClient::connect(&self.socket, "cleanup") {
            let _ = connection.call(None, "daemon.shutdown", json!({}), Some("cleanup"));
        }
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
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
                == Some(session_path.to_string_lossy().as_ref())
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
