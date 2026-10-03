#![cfg(unix)]
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Client {
    stream: BufReader<UnixStream>,
    id: String,
    serial: usize,
}
impl Client {
    fn new(socket: &Path, id: &str) -> Self {
        let socket = UnixStream::connect(socket).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        Self {
            stream: BufReader::new(socket),
            id: id.into(),
            serial: 0,
        }
    }
    fn call(&mut self, agent: Option<&str>, method: &str, params: Value) -> Result<Value, Value> {
        self.serial += 1;
        let id = format!("{}-{}", self.id, self.serial);
        let request = json!({"version":1,"type":"command","request_id":id,"command_id":id,
            "client_id":self.id,"agent_id":agent,"method":method,"params":params});
        writeln!(self.stream.get_mut(), "{request}").unwrap();
        loop {
            let mut line = String::new();
            assert!(self.stream.read_line(&mut line).unwrap() > 0);
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["type"] == "response" && value["id"] == id {
                return if value["ok"] == true {
                    Ok(value["result"].clone())
                } else {
                    Err(value["error"].clone())
                };
            }
        }
    }
}
struct Harness {
    root: PathBuf,
    socket: PathBuf,
    child: Child,
}
impl Harness {
    fn launch(root: &Path) -> Child {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let compiled = PathBuf::from(env!("CARGO_BIN_EXE_qi-agent"));
        let binary = if compiled.is_file() {
            compiled
        } else {
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("qi-agent")
        };
        Command::new(binary)
            .args(["daemon", "serve", "--repository-root"])
            .arg(repository)
            .arg("--config")
            .arg(repository.join("test/fixtures/automation-mock.edn"))
            .env("QI_AGENT_RUNTIME_DIR", root.join("r"))
            .env("QI_AGENT_STATE_DIR", root.join("s"))
            .env("QI_AGENT_REPOSITORY_ROOT", repository)
            .env("QI_AGENT_HOME", root.join("home"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    }
    fn new() -> Self {
        let root =
            PathBuf::from("/tmp").join(format!("qa-{}", &Uuid::new_v4().simple().to_string()[..8]));
        for name in ["r", "s", "w", "home"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let child = Self::launch(&root);
        let socket = root.join("r/daemon.sock");
        let mut result = Self {
            root,
            socket,
            child,
        };
        result.ready();
        result
    }
    fn ready(&mut self) {
        let start = Instant::now();
        while UnixStream::connect(&self.socket).is_err() {
            assert!(self.child.try_wait().unwrap().is_none());
            assert!(start.elapsed() < Duration::from_secs(20));
            thread::sleep(Duration::from_millis(25));
        }
    }
    fn restart(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        self.child = Self::launch(&self.root);
        self.ready();
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        if let Ok(stream) = UnixStream::connect(&self.socket) {
            let mut client = Client {
                stream: BufReader::new(stream),
                id: "cleanup".into(),
                serial: 0,
            };
            let _ = client
                .stream
                .get_ref()
                .set_read_timeout(Some(Duration::from_secs(3)));
            let _ = client.call(None, "daemon.shutdown", json!({}));
        }
        let start = Instant::now();
        while self.child.try_wait().ok().flatten().is_none()
            && start.elapsed() < Duration::from_secs(5)
        {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn model_automation_bridge_observer_fences_and_restart_preserve_durable_state() {
    let mut h = Harness::new();
    let mut controller = Client::new(&h.socket, "controller");
    let created = controller
        .call(None, "agent.create", json!({"workspace":h.root.join("w")}))
        .unwrap();
    let agent = created["agent"]["agent_id"].as_str().unwrap().to_owned();
    controller
        .call(Some(&agent), "agent.attach", json!({"agent_id":agent}))
        .unwrap();
    let mut observer = Client::new(&h.socket, "observer");
    observer
        .call(Some(&agent), "agent.attach", json!({"agent_id":agent}))
        .unwrap();
    for method in [
        "schedule.add",
        "schedule.update",
        "schedule.pause",
        "schedule.resume",
        "schedule.cancel",
        "goal.set",
        "goal.update",
        "goal.pause",
        "goal.resume",
        "goal.complete",
        "goal.cancel",
    ] {
        let error = observer.call(Some(&agent), method, json!({})).unwrap_err();
        assert!(error.to_string().contains("observer"), "{method}: {error}");
    }
    assert!(
        controller
            .call(
                Some(&agent),
                "automation.resolve",
                json!({"id":"guess","ok":true,"result":{}})
            )
            .is_err()
    );
    controller
        .call(
            Some(&agent),
            "turn.submit",
            json!({"message":"Create the requested schedule and bounded goal"}),
        )
        .unwrap();
    let start = Instant::now();
    loop {
        let goals = controller
            .call(Some(&agent), "goal.list", json!({}))
            .unwrap();
        if goals
            .as_array()
            .unwrap()
            .first()
            .is_some_and(|goal| goal["status"] == "budget_exhausted")
        {
            assert_eq!(goals[0]["continuation_count"], 1);
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "model automation bridge stalled: {goals}"
        );
        thread::sleep(Duration::from_millis(50));
    }
    let schedules = controller
        .call(Some(&agent), "schedule.list", json!({}))
        .unwrap();
    assert_eq!(schedules.as_array().unwrap().len(), 1);
    let schedule = &schedules[0];
    assert_eq!(schedule["policy"]["timezone"], "Asia/Hong_Kong");
    let paused = controller
        .call(
            Some(&agent),
            "schedule.pause",
            json!({"schedule_id":schedule["schedule_id"],"expected_revision":schedule["revision"]}),
        )
        .unwrap();
    assert!(controller.call(Some(&agent), "schedule.update", json!({"schedule_id":schedule["schedule_id"],"expected_revision":schedule["revision"],"prompt":"stale"})).is_err());
    let snapshot = controller
        .call(Some(&agent), "session.snapshot", json!({}))
        .unwrap();
    assert!(
        !snapshot.to_string().contains("automation/request"),
        "private bridge request leaked into session"
    );
    drop(observer);
    drop(controller);
    h.restart();
    let mut reconnected = Client::new(&h.socket, "controller-reconnected");
    reconnected
        .call(Some(&agent), "agent.attach", json!({"agent_id":agent}))
        .unwrap();
    let persisted = reconnected
        .call(Some(&agent), "schedule.list", json!({}))
        .unwrap();
    assert_eq!(persisted[0]["status"], "paused");
    assert_eq!(persisted[0]["revision"], paused["revision"]);
    assert_eq!(persisted[0]["policy"]["timezone"], "Asia/Hong_Kong");
}
