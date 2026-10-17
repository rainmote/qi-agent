#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Probe {
    root: PathBuf,
    child: Child,
}

impl Probe {
    fn start(scenario: &str, limit: Option<&str>) -> Self {
        let root = std::env::temp_dir().join(format!("qwd-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(root.join("bin")).unwrap();
        let fixture = root.join("bin/bb");
        fs::write(&fixture, r#"#!/bin/sh
printf '%s\n' "$QI_AGENT_WORKER_GENERATION" >> launches
if [ "$QI_AGENT_WORKER_GENERATION" = 1 ] && [ "$WATCHDOG_FIXTURE" != idle ]; then
  printf '%s\n' '{"type":"event","event":"agent/run/start","run_id":"native","data":{"run-id":"native"}}'
  if [ "$WATCHDOG_FIXTURE" = done ]; then
    printf '%s\n' '{"type":"event","event":"agent/run/end","run_id":"native","data":{"run-id":"native"}}'
  else
    /bin/sleep 60 &
    printf '%s\n' "$!" > descendant
  fi
fi
trap '' TERM
while :; do /bin/sleep 1; done
"#).unwrap();
        fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
        let descriptor = json!({
            "version":1,"worker_id":"w","agent_id":"a","root_agent_id":"a",
            "workspace_id":"workspace","workspace_path":root,"session_path":root.join("session.jsonl"),
            "repository_root":root,"config_path":root.join("unused.edn"),
            "socket_path":root.join("w.sock"),"token":"fixture","generation":1,
            "pid":null,"child_pid":null,"session_id":null,"status":"starting","started_at_ms":0
        });
        let path = root.join("worker.json");
        fs::write(&path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        let binary = PathBuf::from(env!("CARGO_BIN_EXE_qi-agent"));
        let mut command = Command::new(binary);
        command
            .args(["worker", "serve", "--descriptor"])
            .arg(path)
            .current_dir(&root)
            .env_clear()
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", root.join("bin").display()),
            )
            .env("QI_AGENT_HOME", root.join("home"))
            .env("WATCHDOG_FIXTURE", scenario)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if let Some(limit) = limit {
            command.env("QI_AGENT_RUN_WALL_MS", limit);
        }
        let child = command.spawn().unwrap();
        Self { root, child }
    }

    fn launches(&self) -> String {
        fs::read_to_string(self.root.join("launches")).unwrap_or_default()
    }

    fn until(&self, check: impl Fn() -> bool) {
        let start = Instant::now();
        while !check() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "watchdog probe exceeded deadline"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(bytes) = fs::read(self.root.join("worker.json"))
            && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
            && let Some(pid) = value["child_pid"].as_i64()
        {
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        if let Ok(pid) = fs::read_to_string(self.root.join("descendant"))
            && let Ok(pid) = pid.trim().parse::<libc::pid_t>()
        {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn hard_deadline_retires_non_cooperative_group_without_replaying_run() {
    let probe = Probe::start("hung", Some("180"));
    probe.until(|| probe.launches().contains("2\n"));
    let receipt: Value =
        serde_json::from_slice(&fs::read(probe.root.join("worker.watchdog.json")).unwrap())
            .unwrap();
    assert_eq!(receipt["reason"], "hard-wall-timeout");
    assert_eq!(receipt["status"], "uncertain");
    assert_eq!(receipt["verification"], "not-run");
    assert_eq!(receipt["generation"], 1);
    assert_eq!(receipt["run_ids"], json!(["native"]));
    assert_eq!(receipt["signal_sent"], true);
    let pid = fs::read_to_string(probe.root.join("descendant")).unwrap();
    probe.until(|| {
        let output = Command::new("/bin/ps")
            .args(["-p", pid.trim(), "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        !output.status.success() || state.trim().is_empty() || state.trim().starts_with('Z')
    });
    thread::sleep(Duration::from_millis(400));
    assert_eq!(probe.launches(), "1\n2\n");
}

#[test]
fn completed_idle_and_unconfigured_runs_are_not_expired() {
    for (scenario, limit) in [("done", Some("180")), ("idle", Some("180")), ("hung", None)] {
        let mut probe = Probe::start(scenario, limit);
        probe.until(|| probe.launches() == "1\n");
        thread::sleep(Duration::from_millis(400));
        assert!(probe.child.try_wait().unwrap().is_none());
        assert_eq!(probe.launches(), "1\n");
        assert!(!probe.root.join("worker.watchdog.json").exists());
    }
}
