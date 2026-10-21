use crate::paths::{RuntimePaths, env_var, set_owner_only_file};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    os::unix::{
        fs::OpenOptionsExt,
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
    #[serde(default)]
    pub child_process_group: Option<u32>,
    #[serde(default)]
    pub owned_helpers: Vec<crate::desktop_owner::OwnedHelper>,
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
            child_process_group: None,
            owned_helpers: Vec::new(),
            session_id: None,
            status: "starting".into(),
            started_at_ms: now_ms(),
        }
    }
}

type ActiveWriter = Arc<Mutex<Option<(u64, UnixStream)>>>;
type ActiveStdin = Arc<Mutex<Option<BufWriter<ChildStdin>>>>;

/// Host policy, measured with a monotonic clock and independent of provider cooperation.
struct RunDeadline {
    start: Instant,
    started_at_ms: u128,
    deadline_at_ms: u128,
    agent_id: Option<String>,
    session_id: Option<String>,
}

struct RunWatchdog {
    limit: Option<Duration>,
    runs: BTreeMap<String, RunDeadline>,
    generation: u64,
    cancel_started: Option<Instant>,
    grace: Duration,
}

impl RunWatchdog {
    fn new(limit: Option<Duration>) -> Self {
        Self {
            limit,
            runs: BTreeMap::new(),
            generation: 0,
            cancel_started: None,
            grace: Duration::from_millis(250),
        }
    }

    fn observe(&mut self, value: &Value, now: Instant, generation: u64) -> bool {
        if generation != self.generation
            || self.limit.is_none()
            || value.get("type").and_then(Value::as_str) != Some("event")
        {
            return false;
        }
        let Some(id) = value.get("run_id").and_then(Value::as_str) else {
            return false;
        };
        match value.get("event").and_then(Value::as_str) {
            Some("agent/run/start") => {
                if self.runs.contains_key(id) || self.expired(now) {
                    return false;
                }
                let started_at_ms = now_ms();
                self.runs.insert(
                    id.to_owned(),
                    RunDeadline {
                        start: now,
                        started_at_ms,
                        deadline_at_ms: started_at_ms
                            .saturating_add(self.limit.unwrap().as_millis()),
                        agent_id: value
                            .get("agent_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        session_id: value
                            .get("session_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                );
                true
            }
            Some("agent/run/end") => {
                // A terminal delivered at/after the deadline cannot disarm it,
                // even when the timer thread has not yet observed expiry.
                if self.expired(now) {
                    return false;
                }
                self.runs.remove(id).is_some()
            }
            _ => false,
        }
    }

    fn expired(&self, now: Instant) -> bool {
        self.cancel_started.is_some()
            || self.limit.is_some_and(|limit| {
                self.runs
                    .values()
                    .any(|run| now.saturating_duration_since(run.start) >= limit)
            })
    }

    fn records(&self) -> Vec<Value> {
        self.runs
            .iter()
            .map(|(id, run)| {
                json!({
                    "run_id": id, "agent_id": run.agent_id, "session_id": run.session_id,
                    "started_at_ms": run.started_at_ms, "deadline_at_ms": run.deadline_at_ms,
                })
            })
            .collect()
    }

    fn journal(&self, descriptor: &WorkerDescriptor) -> Value {
        json!({"schema_version":1, "worker_id":descriptor.worker_id,
            "generation":self.generation,
            "phase":if self.cancel_started.is_some() {"cancelling"} else {"running"},
            "runs":self.records(), "cancel_grace_ms":self.grace.as_millis()})
    }

    fn fence(&self, value: &mut Value, now: Instant) -> bool {
        if !self.expired(now) {
            return false;
        }
        let terminal = matches!(
            value.get("event").and_then(Value::as_str),
            Some("agent/run/end" | "agent.run/end" | "remote/run-result")
        ) || matches!(
            value.get("type").and_then(Value::as_str),
            Some("run-result" | "result")
        );
        // Read-only snapshots can arrive during cancellation. A matching run
        // outcome cannot expose completed while host arbitration is unresolved.
        self.fence_outcomes(value);
        terminal
    }

    fn fence_outcomes(&self, value: &mut Value) {
        match value {
            Value::Object(object) => {
                let id = object
                    .get("run-id")
                    .or_else(|| object.get("run_id"))
                    .and_then(Value::as_str);
                if id.is_some_and(|id| self.runs.contains_key(id)) && object.contains_key("status")
                {
                    object.insert("status".into(), json!("uncertain"));
                    object.insert("reason".into(), json!("hard-wall-timeout"));
                    object.insert("stop-reason".into(), json!("restored"));
                    object.insert("verification".into(), json!("not-run"));
                    object.insert("host_arbitrated".into(), json!(true));
                }
                for child in object.values_mut() {
                    self.fence_outcomes(child);
                }
            }
            Value::Array(values) => {
                for child in values {
                    self.fence_outcomes(child);
                }
            }
            _ => {}
        }
    }
}

type SharedWatchdog = Arc<Mutex<RunWatchdog>>;

fn run_wall_limit(value: Option<String>) -> Result<Option<Duration>> {
    value
        .map(|value| {
            let milliseconds = value
                .parse::<u64>()
                .context("QI_AGENT_RUN_WALL_MS must be a positive integer")?;
            if milliseconds == 0 {
                bail!("QI_AGENT_RUN_WALL_MS must be a positive integer");
            }
            Ok(Duration::from_millis(milliseconds))
        })
        .transpose()
}

fn write_worker_record(descriptor_path: &Path, extension: &str, value: &Value) -> Result<()> {
    let path = descriptor_path.with_extension(extension);
    let temporary =
        descriptor_path.with_extension(format!("watchdog-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    set_owner_only_file(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.sync_all()?;
    fs::rename(&temporary, &path)?;
    fs::File::open(path.parent().context("watchdog receipt has no parent")?)?.sync_all()?;
    Ok(())
}

fn write_watchdog_receipt(descriptor_path: &Path, value: &Value) -> Result<()> {
    write_worker_record(descriptor_path, "watchdog.json", value)
}

fn cancel_grace(value: Option<String>) -> Result<Duration> {
    let milliseconds = value
        .unwrap_or_else(|| "250".into())
        .parse::<u64>()
        .context("QI_AGENT_RUN_CANCEL_GRACE_MS must be an integer from 1 to 1000")?;
    if !(1..=1000).contains(&milliseconds) {
        bail!("QI_AGENT_RUN_CANCEL_GRACE_MS must be an integer from 1 to 1000");
    }
    Ok(Duration::from_millis(milliseconds))
}

fn request_deadline_cancel(
    stdin: ActiveStdin,
    descriptor: Arc<Mutex<WorkerDescriptor>>,
    generation: u64,
    agents: Vec<String>,
) {
    // A full/busy RPC pipe must not block host enforcement. The old pipe closes
    // on retirement, and the generation check forbids writing into its replacement.
    thread::spawn(move || {
        let mut current = stdin.lock().expect("worker stdin mutex poisoned");
        if descriptor
            .lock()
            .expect("descriptor mutex poisoned")
            .generation
            != generation
        {
            return;
        }
        if let Some(writer) = current.as_mut() {
            for agent in agents {
                let root = descriptor
                    .lock()
                    .expect("descriptor mutex poisoned")
                    .agent_id
                    .clone();
                let request = if agent == root {
                    json!({"id":format!("watchdog-{}", uuid::Uuid::new_v4()),"method":"turn.abort","params":{}})
                } else {
                    json!({"id":format!("watchdog-{}", uuid::Uuid::new_v4()),"method":"subagent.invoke",
                        "params":{"agent_id":agent,"method":"turn.abort","params":{}}})
                };
                if serde_json::to_writer(&mut *writer, &request).is_err()
                    || writer.write_all(b"\n").is_err()
                    || writer.flush().is_err()
                {
                    break;
                }
            }
        }
    });
}

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
    let wall_limit = match std::env::var("QI_AGENT_RUN_WALL_MS") {
        Ok(value) => run_wall_limit(Some(value))?,
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(error).context("invalid QI_AGENT_RUN_WALL_MS"),
    };
    let watchdog = Arc::new(Mutex::new(RunWatchdog::new(wall_limit)));
    watchdog.lock().expect("watchdog mutex poisoned").grace =
        match std::env::var("QI_AGENT_RUN_CANCEL_GRACE_MS") {
            Ok(value) => cancel_grace(Some(value))?,
            Err(std::env::VarError::NotPresent) => cancel_grace(None)?,
            Err(error) => return Err(error).context("invalid QI_AGENT_RUN_CANCEL_GRACE_MS"),
        };
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
        Arc::clone(&watchdog),
        Arc::clone(&shutdown_requested),
    )?;
    let mut child_started = Instant::now();
    let mut restart_attempts = 0u32;

    let connection_epoch = Arc::new(AtomicU64::new(0));
    let mut hard_timeout = false;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                let epoch = connection_epoch.fetch_add(1, Ordering::SeqCst) + 1;
                // Authentication has its own bounded read; it must not stall the host timer.
                let token = descriptor.token.clone();
                let latest_epoch = Arc::clone(&connection_epoch);
                let active = Arc::clone(&active);
                let stdin = Arc::clone(&stdin);
                let events = Arc::clone(&event_buffer);
                let descriptor = Arc::clone(&live_descriptor);
                let shutdown = Arc::clone(&shutdown_requested);
                let watchdog = Arc::clone(&watchdog);
                let log_directory = log_directory.clone();
                thread::spawn(move || {
                    if let Err(error) = authenticate_and_attach(
                        stream,
                        epoch,
                        &token,
                        active,
                        stdin,
                        events,
                        Arc::clone(&descriptor),
                        shutdown,
                        latest_epoch,
                        watchdog,
                    ) {
                        let worker_id = &descriptor
                            .lock()
                            .expect("descriptor mutex poisoned")
                            .worker_id;
                        append_log(
                            &log_directory,
                            worker_id,
                            &format!("private connection rejected: {error:#}\n"),
                        );
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error).context("worker private socket failed"),
        }

        {
            let mut timer = watchdog.lock().expect("watchdog mutex poisoned");
            let now = Instant::now();
            if timer.expired(now) && timer.cancel_started.is_none() {
                timer.cancel_started = Some(now);
                let current = live_descriptor.lock().expect("descriptor mutex poisoned");
                if let Err(error) = write_worker_record(
                    &descriptor_path,
                    "deadlines.json",
                    &timer.journal(&current),
                ) {
                    append_log(
                        &log_directory,
                        &descriptor.worker_id,
                        &format!("deadline cancellation persistence failed: {error:#}\n"),
                    );
                }
                let mut agents = vec![current.agent_id.clone()];
                agents.extend(timer.runs.values().filter_map(|run| run.agent_id.clone()));
                agents.sort();
                agents.dedup();
                request_deadline_cancel(
                    Arc::clone(&stdin),
                    Arc::clone(&live_descriptor),
                    current.generation,
                    agents,
                );
            }
            if !hard_timeout
                && timer
                    .cancel_started
                    .is_some_and(|start| now.saturating_duration_since(start) >= timer.grace)
            {
                let current = live_descriptor.lock().expect("descriptor mutex poisoned");
                let mut receipt = json!({
                    "schema_version":1, "reason": "hard-wall-timeout", "status": "uncertain",
                    "verification": "not-run", "generation": current.generation,
                    "worker_id": current.worker_id, "child_pid": child.id(),
                    "run_ids": timer.runs.keys().collect::<Vec<_>>(),
                    "runs":timer.records(), "cancel_requested":true, "cancel_grace_ms":timer.grace.as_millis(),
                    "at_ms": now_ms(), "limit_ms": wall_limit.map(|limit| limit.as_millis()),
                    "signal_sent": false
                });
                drop(current);
                if let Err(error) = write_watchdog_receipt(&descriptor_path, &receipt) {
                    append_log(
                        &log_directory,
                        &descriptor.worker_id,
                        &format!("watchdog intent persistence failed: {error:#}\n"),
                    );
                }
                // The unreaped Child owns this PID and its separate process group.
                let signal = unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                receipt["signal_sent"] = json!(signal == 0);
                if signal != 0 {
                    receipt["signal_error"] = json!(std::io::Error::last_os_error().to_string());
                    let _ = child.kill();
                }
                if let Err(error) = write_watchdog_receipt(&descriptor_path, &receipt) {
                    append_log(
                        &log_directory,
                        &descriptor.worker_id,
                        &format!("watchdog result persistence failed: {error:#}\n"),
                    );
                }
                append_log(
                    &log_directory,
                    &descriptor.worker_id,
                    &format!("{receipt}\n"),
                );
                timer.runs.clear();
                hard_timeout = true;
            }
        }
        if let Some(status) = child.try_wait()? {
            watchdog
                .lock()
                .expect("watchdog mutex poisoned")
                .runs
                .clear();
            *stdin.lock().expect("worker stdin mutex poisoned") = None;
            let mut current = live_descriptor.lock().expect("descriptor mutex poisoned");
            let intentional = shutdown_requested.load(Ordering::SeqCst);
            current.status = if intentional && status.success() {
                "stopped".into()
            } else {
                "failed".into()
            };
            // Retire any members left in the owned generation's group before replacement.
            if let Some(group) = current.child_process_group {
                unsafe {
                    libc::kill(-(group as libc::pid_t), libc::SIGKILL);
                }
            }
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
                "data": {"status": status.code(), "worker_id": current.worker_id,
                         "reason": if hard_timeout { "hard-wall-timeout" } else { "process-exit" },
                         "outcome": "uncertain"}
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
                Arc::clone(&watchdog),
                Arc::clone(&shutdown_requested),
            )?;
            child_started = Instant::now();
            hard_timeout = false;
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
    watchdog: SharedWatchdog,
    closing: Arc<AtomicBool>,
) -> Result<std::process::Child> {
    let snapshot = descriptor
        .lock()
        .expect("descriptor mutex poisoned")
        .clone();
    if !crate::desktop_owner::helpers_absent(&snapshot.owned_helpers)? {
        bail!(
            "previous owned terminal guardian is still present or cleanup UNKNOWN; worker replacement blocked"
        );
    }
    descriptor
        .lock()
        .expect("descriptor mutex poisoned")
        .owned_helpers
        .clear();
    {
        let mut timer = watchdog.lock().expect("watchdog mutex poisoned");
        timer.runs.clear();
        timer.generation = snapshot.generation;
        timer.cancel_started = None;
        if timer.limit.is_some() {
            write_worker_record(descriptor_path, "deadlines.json", &timer.journal(&snapshot))?;
        }
    }
    let own_process_group = watchdog
        .lock()
        .expect("watchdog mutex poisoned")
        .limit
        .is_some();
    let classpath = std::env::join_paths([
        snapshot.repository_root.join("src"),
        snapshot.repository_root.join("plugins"),
    ])?;
    let mut command = Command::new("bb");
    command
        .arg("-cp")
        .arg(classpath)
        .arg("-m")
        .arg("qi.cli")
        .arg("--config")
        .arg(&snapshot.config_path)
        .arg("--session")
        .arg(&snapshot.session_path)
        .arg("--mode")
        .arg("rpc")
        .current_dir(&snapshot.workspace_path)
        .env("QI_AGENT_ID", &snapshot.agent_id)
        .env("QI_AGENT_WORKER_ID", &snapshot.worker_id)
        .env(
            "QI_AGENT_WORKER_GENERATION",
            snapshot.generation.to_string(),
        )
        .env("DAO_AGENT_ID", &snapshot.agent_id)
        .env("DAO_WORKER_ID", &snapshot.worker_id)
        .env("DAO_WORKER_GENERATION", snapshot.generation.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if own_process_group {
        command.process_group(0);
        command.env(
            "QI_AGENT_HOST_DEADLINE_RECEIPT",
            descriptor_path.with_extension("watchdog.json"),
        );
    }
    if let Some(backend) = &snapshot.repl_backend {
        command
            .env("QI_AGENT_REPL_BACKEND", backend)
            .env("DAO_REPL_BACKEND", backend);
    }
    if let Some(seconds) = env_var("QI_AGENT_WORKER_CPU_SECONDS", "DAO_WORKER_CPU_SECONDS")
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
        current.child_process_group = own_process_group.then_some(child.id());
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
        watchdog,
        snapshot.generation,
        Arc::clone(&stdin),
        closing,
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
    latest_epoch: Arc<AtomicU64>,
    watchdog: SharedWatchdog,
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
        if latest_epoch.load(Ordering::SeqCst) != epoch {
            bail!("worker connection superseded during authentication");
        }
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
            let request = serde_json::from_str::<Value>(&line).unwrap_or(Value::Null);
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let allowed_during_cancel = matches!(
                method,
                "shutdown"
                    | "turn.abort"
                    | "turn.state"
                    | "session.snapshot"
                    | "session.events"
                    | "runtime.status"
                    | "remote.methods"
                    | "terminal.status"
                    | "terminal.stop"
                    | "terminal.cancel"
                    | "workspace.runtime-status"
                    | "workspace.office-cancel"
            ) || (method == "subagent.invoke"
                && request.pointer("/params/method").and_then(Value::as_str) == Some("turn.abort"));
            if !allowed_during_cancel
                && watchdog
                    .lock()
                    .expect("watchdog mutex poisoned")
                    .expired(Instant::now())
            {
                send_active(
                    &active,
                    &json!({"version":1,"type":"response","id":request.get("id"),"ok":false,
                    "error":{"message":"Worker deadline expired; reconcile before resubmitting",
                        "data":{"type":"deadline_cancelling"}}}),
                );
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

#[allow(clippy::too_many_arguments)]
fn spawn_stdout_reader(
    stdout: impl Read + Send + 'static,
    active: ActiveWriter,
    event_buffer: Arc<Mutex<VecDeque<Value>>>,
    sequence: Arc<AtomicU64>,
    descriptor: Arc<Mutex<WorkerDescriptor>>,
    descriptor_path: PathBuf,
    watchdog: SharedWatchdog,
    generation: u64,
    stdin: ActiveStdin,
    closing: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            // An old pipe may drain after replacement; it cannot arm or finish a new run.
            if descriptor
                .lock()
                .expect("descriptor mutex poisoned")
                .generation
                != generation
            {
                break;
            }
            {
                let mut timer = watchdog.lock().expect("watchdog mutex poisoned");
                let now = Instant::now();
                if timer.observe(&value, now, generation) {
                    let current = descriptor.lock().expect("descriptor mutex poisoned");
                    if let Err(error) = write_worker_record(
                        &descriptor_path,
                        "deadlines.json",
                        &timer.journal(&current),
                    ) {
                        eprintln!("worker deadline journal persistence failed: {error:#}");
                    }
                }
                if timer.fence(&mut value, now) {
                    continue;
                }
            }
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if kind == "process-admit" {
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| uuid::Uuid::parse_str(id).is_ok());
                let pid = value
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| u32::try_from(pid).ok());
                if let (Some(id), Some(pid)) = (id, pid) {
                    let admitted = (|| -> Result<()> {
                        if closing.load(Ordering::SeqCst)
                            || watchdog
                                .lock()
                                .expect("watchdog mutex poisoned")
                                .cancel_started
                                .is_some()
                        {
                            bail!("process admission closed");
                        }
                        let mut current = descriptor.lock().expect("descriptor mutex poisoned");
                        if current.generation != generation || current.status != "running" {
                            bail!("process admission closed");
                        }
                        let mut remaining = Vec::new();
                        for helper in &current.owned_helpers {
                            if crate::desktop_owner::helper_present(helper)? {
                                remaining.push(helper.clone());
                            }
                        }
                        current.owned_helpers = remaining;
                        if current.owned_helpers.len() >= 32 {
                            bail!("process admission closed");
                        }
                        let parent = current.child_pid.context("worker parent unavailable")?;
                        let observed = crate::desktop_owner::helper_identity(pid)?
                            .context("helper disappeared before admission")?;
                        let record = crate::desktop_owner::admit_helper(parent, observed)?;
                        if !current.owned_helpers.contains(&record) {
                            current.owned_helpers.push(record);
                        }
                        write_descriptor(&descriptor_path, &current)?;
                        Ok(())
                    })()
                    .is_ok();
                    let ack = json!({"id":format!("native-process-ack-{id}"),"method":"native.process-result",
                        "params":{"id":id,"admitted":admitted}});
                    if let Some(writer) =
                        stdin.lock().expect("worker stdin mutex poisoned").as_mut()
                    {
                        let _ = (|| -> Result<()> {
                            serde_json::to_writer(&mut *writer, &ack)?;
                            writer.write_all(b"\n")?;
                            writer.flush()?;
                            Ok(())
                        })();
                    }
                }
                continue;
            }
            if kind == "response"
                && value
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with("native-process-ack-"))
            {
                continue;
            }
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
    fn watchdog_uses_first_start_and_ignores_stale_generations() {
        let mut timer = RunWatchdog::new(Some(Duration::from_millis(100)));
        timer.generation = 2;
        let start = Instant::now();
        let event = |kind, id| json!({"type":"event", "event":kind, "run_id":id});
        timer.observe(&event("agent/run/start", "current"), start, 2);
        timer.observe(
            &event("agent/run/start", "current"),
            start + Duration::from_millis(90),
            2,
        );
        timer.observe(
            &event("agent/run/end", "current"),
            start + Duration::from_millis(95),
            1,
        );
        assert!(!timer.expired(start + Duration::from_millis(99)));
        assert!(timer.expired(start + Duration::from_millis(100)));
        timer.observe(
            &event("agent/run/end", "current"),
            start + Duration::from_millis(100),
            2,
        );
        timer.observe(&event("agent/run/start", "old"), start, 1);
        assert!(timer.expired(start + Duration::from_secs(1)));
    }

    #[test]
    fn watchdog_policy_is_explicit_and_invalid_values_fail_closed() {
        assert!(run_wall_limit(None).unwrap().is_none());
        assert_eq!(
            run_wall_limit(Some("180".into())).unwrap(),
            Some(Duration::from_millis(180))
        );
        for invalid in ["", "0", "-1", "1.5", "99999999999999999999999"] {
            assert!(run_wall_limit(Some(invalid.into())).is_err());
        }
        assert_eq!(cancel_grace(None).unwrap(), Duration::from_millis(250));
        for invalid in ["0", "-1", "1001", "x"] {
            assert!(cancel_grace(Some(invalid.into())).is_err());
        }
    }

    #[test]
    fn deadline_wins_equal_and_late_terminal_races_and_fences_snapshots() {
        let start = Instant::now();
        for offset in [100, 101] {
            let mut timer = RunWatchdog::new(Some(Duration::from_millis(100)));
            timer.generation = 1;
            timer.observe(
                &json!({"type":"event","event":"agent/run/start","run_id":"r"}),
                start,
                1,
            );
            let now = start + Duration::from_millis(offset);
            timer.observe(
                &json!({"type":"event","event":"agent/run/end","run_id":"r"}),
                now,
                1,
            );
            assert!(timer.expired(now));
            let mut terminal = json!({"type":"event","event":"agent/run/end","run_id":"r"});
            assert!(timer.fence(&mut terminal, now));
            let mut snapshot = json!({"type":"response","result":{"last-outcome":{"run-id":"r","status":"completed"}}});
            assert!(!timer.fence(&mut snapshot, now));
            assert_eq!(
                snapshot.pointer("/result/last-outcome/status"),
                Some(&json!("uncertain"))
            );
        }
        let mut timer = RunWatchdog::new(Some(Duration::from_millis(100)));
        timer.generation = 1;
        timer.observe(
            &json!({"type":"event","event":"agent/run/start","run_id":"r"}),
            start,
            1,
        );
        timer.observe(
            &json!({"type":"event","event":"agent/run/end","run_id":"r"}),
            start + Duration::from_millis(99),
            1,
        );
        assert!(!timer.expired(start + Duration::from_millis(200)));
    }

    #[test]
    fn descriptor_round_trips_without_losing_identity() {
        let root =
            std::env::temp_dir().join(format!("qi-agent-worker-test-{}", uuid::Uuid::new_v4()));
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
