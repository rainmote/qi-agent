use crate::{
    paths::{
        RuntimePaths, canonical, discover_repository_root, env_var, set_owner_only_dir,
        set_owner_only_file,
    },
    wire::{self, PROTOCOL_VERSION, PublicCommand},
    worker_proxy::{WorkerDescriptor, read_descriptor, write_descriptor},
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    os::unix::{
        fs::OpenOptionsExt,
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const PUBLIC_EVENT_BUFFER_LIMIT: usize = 2_000;
const ATTACHMENT_QUEUE_LIMIT: usize = 256;
const SNAPSHOT_INLINE_LIMIT: usize = 256 * 1024;
const SNAPSHOT_CHUNK_CHARS: usize = 64 * 1024;
const WORKER_RPC_TIMEOUT: Duration = Duration::from_secs(60);
const SCHEMA_REVISION: i64 = 6;
const DEFAULT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_LOG_BACKUPS: usize = 3;
const DEFAULT_MAX_WORKER_LOGS: usize = 100;
const DATABASE_BACKUPS_TO_KEEP: usize = 5;

#[derive(Clone, Debug)]
struct AgentRecord {
    agent_id: String,
    root_agent_id: String,
    workspace_id: String,
    workspace_path: PathBuf,
    session_id: Option<String>,
    session_path: PathBuf,
    worker_id: String,
    preset_id: Option<String>,
    name: Option<String>,
    status: String,
    controller_client_id: Option<String>,
    created_at_ms: u128,
    lifecycle: String,
    last_activity_at_ms: Option<u128>,
    inactive_reason: Option<String>,
}

#[derive(Debug)]
struct PublicApiError {
    code: String,
    message: String,
}

impl fmt::Display for PublicApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PublicApiError {}

fn api_error(code: impl Into<String>, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(PublicApiError {
        code: code.into(),
        message: message.into(),
    })
}

struct WorkerConnection {
    descriptor: WorkerDescriptor,
    writer: Mutex<BufWriter<UnixStream>>,
    pending: Mutex<HashMap<String, SyncSender<Value>>>,
    events: Mutex<VecDeque<Value>>,
    attachments: Mutex<HashMap<String, (String, SyncSender<Value>)>>,
    sequence: AtomicU64,
    generation: AtomicU64,
    status: Mutex<String>,
    alive: AtomicBool,
    lifecycle: Mutex<()>,
}

impl WorkerConnection {
    fn call(&self, method: &str, parameters: Value, timeout: Duration) -> Result<Value> {
        let started = Instant::now();
        let pending = {
            let _guard = self
                .lifecycle
                .lock()
                .expect("worker lifecycle mutex poisoned");
            self.begin_call(method, parameters)?
        };
        // Admission is fenced against retirement; waiting for the result must
        // not prevent another caller from interrupting this operation.
        self.finish_call(method, pending, timeout.saturating_sub(started.elapsed()))
    }

    fn call_inner(&self, method: &str, parameters: Value, timeout: Duration) -> Result<Value> {
        let pending = self.begin_call(method, parameters)?;
        self.finish_call(method, pending, timeout)
    }

    fn begin_call(
        &self,
        method: &str,
        parameters: Value,
    ) -> Result<(String, mpsc::Receiver<Value>)> {
        if !self.alive.load(Ordering::SeqCst) {
            bail!("worker {} is unavailable", self.descriptor.worker_id);
        }
        let id = format!("daemon-{}", Uuid::new_v4());
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .expect("worker pending mutex poisoned")
            .insert(id.clone(), tx);
        let write_result = (|| -> Result<()> {
            let mut writer = self.writer.lock().expect("worker writer mutex poisoned");
            serde_json::to_writer(
                &mut *writer,
                &json!({"id": id, "method": method, "params": parameters}),
            )?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            Ok(())
        })();
        if let Err(error) = write_result {
            self.pending
                .lock()
                .expect("worker pending mutex poisoned")
                .remove(&id);
            return Err(error).with_context(|| {
                format!("worker RPC {method} write failed; outcome is uncertain")
            });
        }
        Ok((id, rx))
    }

    fn finish_call(
        &self,
        method: &str,
        (id, rx): (String, mpsc::Receiver<Value>),
        timeout: Duration,
    ) -> Result<Value> {
        let response = rx.recv_timeout(timeout).map_err(|error| {
            self.pending
                .lock()
                .expect("worker pending mutex poisoned")
                .remove(&id);
            anyhow!("worker RPC {method} did not complete: {error}")
        })?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("worker RPC failed");
            bail!("{message}")
        }
    }

    fn attach_at_sequence(
        &self,
        attachment_id: String,
        agent_id: String,
        sender: SyncSender<Value>,
    ) -> u64 {
        let events = self.events.lock().expect("worker events mutex poisoned");
        let sequence = self.sequence.load(Ordering::SeqCst);
        self.attachments
            .lock()
            .expect("worker attachments mutex poisoned")
            .insert(attachment_id, (agent_id, sender));
        drop(events);
        sequence
    }

    fn detach(&self, attachment_id: &str) {
        self.attachments
            .lock()
            .expect("worker attachments mutex poisoned")
            .remove(attachment_id);
    }

    fn replay_after(&self, agent_id: &str, generation: u64, sequence: u64) -> (String, Vec<Value>) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return ("unavailable".into(), Vec::new());
        }
        let events = self.events.lock().expect("worker events mutex poisoned");
        let oldest = events
            .iter()
            .find(|value| value.get("agent_id").and_then(Value::as_str) == Some(agent_id))
            .and_then(|value| value.pointer("/cursor/sequence"))
            .and_then(Value::as_u64)
            .unwrap_or(sequence);
        if sequence > 0 && sequence.saturating_add(1) < oldest {
            return ("partial".into(), Vec::new());
        }
        (
            "complete".into(),
            events
                .iter()
                .filter(|event| {
                    event
                        .pointer("/cursor/sequence")
                        .and_then(Value::as_u64)
                        .is_some_and(|value| value > sequence)
                        && event.get("agent_id").and_then(Value::as_str) == Some(agent_id)
                })
                .cloned()
                .collect(),
        )
    }

    fn broadcast(&self, value: Value) {
        let mut disconnected = Vec::new();
        {
            let attachments = self
                .attachments
                .lock()
                .expect("worker attachments mutex poisoned");
            for (id, (agent_id, sender)) in attachments.iter() {
                if value.get("agent_id").and_then(Value::as_str) != Some(agent_id) {
                    continue;
                }
                match sender.try_send(value.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                        disconnected.push(id.clone());
                    }
                }
            }
        }
        if !disconnected.is_empty() {
            let mut attachments = self
                .attachments
                .lock()
                .expect("worker attachments mutex poisoned");
            for id in disconnected {
                attachments.remove(&id);
            }
        }
    }
}

struct Runtime {
    paths: RuntimePaths,
    repository_root: PathBuf,
    config_path: PathBuf,
    database: Database,
    agents: Mutex<HashMap<String, AgentRecord>>,
    workers: Mutex<HashMap<String, Arc<WorkerConnection>>>,
    residency: Mutex<()>,
    shutdown: AtomicBool,
    desktop_owned: bool,
    desktop_startup_unknown: AtomicBool,
    idle_sweep_running: AtomicBool,
    last_idle_sweep_at_ms: AtomicU64,
    next_idle_sweep_at_ms: AtomicU64,
}

#[derive(Clone)]
struct Database {
    path: PathBuf,
}

enum JournalEntry {
    New,
    Completed(Value),
    Failed(Value),
    Pending,
}

#[derive(Clone, Debug)]
struct ScheduleClaim {
    schedule_id: String,
    agent_id: String,
    expression: String,
    policy: Value,
    claim: String,
    delivery_id: String,
}

#[derive(Clone, Debug)]
struct GoalContinuation {
    previous_request_id: Option<String>,
    goal_id: String,
    agent_id: String,
    objective: String,
    continuation_count: u64,
    max_continuations: u64,
}

#[derive(Debug)]
struct IdleInspection {
    eligible: bool,
    pin_reasons: Vec<String>,
    last_activity_at_ms: Option<u128>,
    lifecycle: String,
    agent_ids: HashSet<String>,
}

impl Database {
    fn new(path: PathBuf) -> Result<Self> {
        let database = Self { path };
        database.initialize()?;
        Ok(database)
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        protect_sqlite_files(&self.path)?;
        Ok(connection)
    }

    fn initialize(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
            set_owner_only_dir(parent)?;
        }
        let existed = self
            .path
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 0);
        let connection = self.connection()?;
        if existed {
            let integrity = quick_check(&connection)?;
            if integrity != "ok" {
                bail!("database integrity check failed before migration: {integrity}");
            }
        }
        let revision: i64 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if revision > SCHEMA_REVISION {
            bail!(
                "database schema revision {revision} is newer than supported revision {SCHEMA_REVISION}"
            );
        }
        let has_schema: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type='table' AND name NOT LIKE 'sqlite_%'
             )",
            [],
            |row| row.get(0),
        )?;
        drop(connection);
        if existed && has_schema && revision < SCHEMA_REVISION {
            self.backup(&format!("pre-v{revision}"))?;
        }

        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let migration = (|| -> Result<()> {
            connection.execute_batch(
                "
            CREATE TABLE IF NOT EXISTS agents (
              agent_id TEXT PRIMARY KEY,
              root_agent_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL,
              workspace_path TEXT NOT NULL,
              session_id TEXT,
              session_path TEXT NOT NULL UNIQUE,
              worker_id TEXT NOT NULL UNIQUE,
              preset_id TEXT,
              name TEXT,
              status TEXT NOT NULL,
              controller_client_id TEXT,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              lifecycle TEXT NOT NULL DEFAULT 'draft',
              last_activity_at_ms INTEGER,
              inactive_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS workers (
              worker_id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              pid INTEGER,
              child_pid INTEGER,
              generation INTEGER NOT NULL,
              status TEXT NOT NULL,
              heartbeat_at_ms INTEGER NOT NULL,
              descriptor_path TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
              task_id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              run_id TEXT,
              status TEXT NOT NULL,
              continuation_count INTEGER NOT NULL DEFAULT 0,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS commands (
              client_id TEXT NOT NULL,
              command_id TEXT NOT NULL,
              agent_id TEXT,
              method TEXT NOT NULL,
              params_json TEXT NOT NULL,
              status TEXT NOT NULL,
              outcome_json TEXT,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (client_id, command_id)
            );
            CREATE TABLE IF NOT EXISTS schedules (
              schedule_id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              expression TEXT NOT NULL,
              next_at_ms INTEGER,
              claim TEXT,
              policy_json TEXT NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS goals (
              goal_id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              objective TEXT NOT NULL,
              status TEXT NOT NULL,
              continuation_count INTEGER NOT NULL DEFAULT 0,
              max_continuations INTEGER NOT NULL,
              last_request_id TEXT,
              last_error TEXT,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS goal_runs (
              request_id TEXT PRIMARY KEY,
              goal_id TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL,
              completed_at_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS leases (
              resource_type TEXT NOT NULL,
              resource_key TEXT NOT NULL,
              owner TEXT NOT NULL,
              expires_at_ms INTEGER,
              uncertain_request_id TEXT,
              PRIMARY KEY (resource_type, resource_key)
            );
            CREATE TABLE IF NOT EXISTS messages (
              message_id TEXT PRIMARY KEY,
              from_agent_id TEXT NOT NULL,
              to_agent_id TEXT NOT NULL,
              body TEXT NOT NULL,
              status TEXT NOT NULL,
              delivery_json TEXT,
              created_at_ms INTEGER NOT NULL,
              delivered_at_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS session_archives (
              source_path TEXT PRIMARY KEY,
              archive_path TEXT NOT NULL UNIQUE,
              agent_id TEXT,
              status TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agents_workspace_idx ON agents(workspace_id);
            CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id);
            CREATE INDEX IF NOT EXISTS goals_agent_idx ON goals(agent_id,status);
            CREATE INDEX IF NOT EXISTS messages_target_idx
              ON messages(to_agent_id,status);
            ",
            )?;
            ensure_column(
                &connection,
                "agents",
                "preset_id",
                "ALTER TABLE agents ADD COLUMN preset_id TEXT",
            )?;
            ensure_column(
                &connection,
                "leases",
                "uncertain_request_id",
                "ALTER TABLE leases ADD COLUMN uncertain_request_id TEXT",
            )?;
            ensure_column(
                &connection,
                "agents",
                "lifecycle",
                "ALTER TABLE agents ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'draft'",
            )?;
            ensure_column(
                &connection,
                "agents",
                "last_activity_at_ms",
                "ALTER TABLE agents ADD COLUMN last_activity_at_ms INTEGER",
            )?;
            ensure_column(
                &connection,
                "agents",
                "inactive_reason",
                "ALTER TABLE agents ADD COLUMN inactive_reason TEXT",
            )?;
            for table in ["schedules", "goals"] {
                ensure_column(
                    &connection,
                    table,
                    "revision",
                    &format!("ALTER TABLE {table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"),
                )?;
            }
            connection.pragma_update(None, "user_version", SCHEMA_REVISION)?;
            Ok(())
        })();
        if let Err(error) = migration {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }
        connection.execute_batch("COMMIT")?;
        protect_sqlite_files(&self.path)?;
        Ok(())
    }

    fn schema_revision(&self) -> Result<i64> {
        self.connection()?
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(Into::into)
    }

    fn integrity(&self) -> Result<String> {
        quick_check(&self.connection()?)
    }

    fn backup(&self, label: &str) -> Result<PathBuf> {
        let parent = self
            .path
            .parent()
            .context("database path has no parent directory")?;
        let backup_dir = parent.join("backups");
        fs::create_dir_all(&backup_dir)?;
        set_owner_only_dir(&backup_dir)?;
        let safe_label: String = label
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '-'
                }
            })
            .take(40)
            .collect();
        let backup_path = backup_dir.join(format!(
            "supervisor-{safe_label}-{}-{}.sqlite",
            now_ms(),
            &Uuid::new_v4().simple().to_string()[..8]
        ));
        self.connection()?.execute(
            "VACUUM main INTO ?1",
            params![backup_path.to_string_lossy()],
        )?;
        set_owner_only_file(&backup_path)?;
        prune_database_backups(&backup_dir, DATABASE_BACKUPS_TO_KEEP)?;
        Ok(backup_path)
    }

    fn upsert_agent(&self, agent: &AgentRecord) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO agents
             (agent_id, root_agent_id, workspace_id, workspace_path, session_id,
              session_path, worker_id, preset_id, name, status, controller_client_id,
              created_at_ms, updated_at_ms, lifecycle, last_activity_at_ms,
              inactive_reason)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(agent_id) DO UPDATE SET
              session_id=excluded.session_id, status=excluded.status,
              session_path=excluded.session_path,
              preset_id=excluded.preset_id,
              controller_client_id=excluded.controller_client_id,
              lifecycle=excluded.lifecycle,
              last_activity_at_ms=excluded.last_activity_at_ms,
              inactive_reason=excluded.inactive_reason,
              updated_at_ms=excluded.updated_at_ms",
            params![
                agent.agent_id,
                agent.root_agent_id,
                agent.workspace_id,
                agent.workspace_path.to_string_lossy(),
                agent.session_id,
                agent.session_path.to_string_lossy(),
                agent.worker_id,
                agent.preset_id,
                agent.name,
                agent.status,
                agent.controller_client_id,
                i64::try_from(agent.created_at_ms).unwrap_or(i64::MAX),
                now_ms_i64(),
                agent.lifecycle,
                agent
                    .last_activity_at_ms
                    .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
                agent.inactive_reason,
            ],
        )?;
        Ok(())
    }

    fn upsert_worker(&self, descriptor: &WorkerDescriptor, descriptor_path: &Path) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO workers
             (worker_id, agent_id, pid, child_pid, generation, status,
              heartbeat_at_ms, descriptor_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(worker_id) DO UPDATE SET pid=excluded.pid,
              child_pid=excluded.child_pid, generation=excluded.generation,
              status=excluded.status, heartbeat_at_ms=excluded.heartbeat_at_ms,
              descriptor_path=excluded.descriptor_path",
            params![
                descriptor.worker_id,
                descriptor.agent_id,
                descriptor.pid.map(i64::from),
                descriptor.child_pid.map(i64::from),
                i64::try_from(descriptor.generation).unwrap_or(i64::MAX),
                descriptor.status,
                now_ms_i64(),
                descriptor_path.to_string_lossy(),
            ],
        )?;
        Ok(())
    }

    fn set_worker_status(&self, worker_id: &str, status: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE workers SET status=?2,heartbeat_at_ms=?3 WHERE worker_id=?1",
            params![worker_id, status, now_ms_i64()],
        )?;
        Ok(())
    }

    fn load_agents(&self) -> Result<Vec<AgentRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT agent_id,root_agent_id,workspace_id,workspace_path,session_id,
             session_path,worker_id,preset_id,name,status,controller_client_id,created_at_ms,
             lifecycle,last_activity_at_ms,inactive_reason
             FROM agents ORDER BY created_at_ms DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AgentRecord {
                agent_id: row.get(0)?,
                root_agent_id: row.get(1)?,
                workspace_id: row.get(2)?,
                workspace_path: PathBuf::from(row.get::<_, String>(3)?),
                session_id: row.get(4)?,
                session_path: PathBuf::from(row.get::<_, String>(5)?),
                worker_id: row.get(6)?,
                preset_id: row.get(7)?,
                name: row.get(8)?,
                status: row.get(9)?,
                controller_client_id: row.get(10)?,
                created_at_ms: row.get::<_, i64>(11)?.max(0) as u128,
                lifecycle: row.get(12)?,
                last_activity_at_ms: row
                    .get::<_, Option<i64>>(13)?
                    .map(|value| value.max(0) as u128),
                inactive_reason: row.get(14)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn remove_failed_agent_start(&self, agent_id: &str, worker_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM workers WHERE worker_id=?1 OR agent_id=?2",
            params![worker_id, agent_id],
        )?;
        transaction.execute("DELETE FROM agents WHERE agent_id=?1", params![agent_id])?;
        transaction.commit()?;
        Ok(())
    }

    fn begin_command(&self, command: &PublicCommand) -> Result<JournalEntry> {
        let command_id = command
            .command_id
            .as_deref()
            .context("mutation requires command_id")?;
        let parameters_json = serde_json::to_string(&command.params)?;
        let connection = self.connection()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO commands
             (client_id,command_id,agent_id,method,params_json,status,
              created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,'pending',?6,?6)",
            params![
                command.journal_client_id(),
                command_id,
                command.agent_id,
                command.method,
                parameters_json,
                now_ms_i64(),
            ],
        )?;
        if inserted == 1 {
            return Ok(JournalEntry::New);
        }
        let existing: (String, Option<String>, String, String, Option<String>) = connection
            .query_row(
                "SELECT status,outcome_json,method,params_json,agent_id FROM commands
             WHERE client_id=?1 AND command_id=?2",
                params![command.journal_client_id(), command_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
        if existing.2 != command.method
            || existing.3 != serde_json::to_string(&command.params)?
            || existing.4 != command.agent_id
        {
            bail!("command_id was already used for a different mutation")
        }
        let parsed = existing
            .1
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(match existing.0.as_str() {
            "completed" => JournalEntry::Completed(parsed),
            "failed" => JournalEntry::Failed(parsed),
            _ => JournalEntry::Pending,
        })
    }

    fn command_status(&self, client_id: &str, command_id: &str) -> Result<Value> {
        let connection = self.connection()?;
        let row: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT status,outcome_json FROM commands WHERE client_id=?1 AND command_id=?2",
                params![client_id, command_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((status, outcome)) = row else {
            return Ok(json!({"status": "not_found", "command_id": command_id}));
        };
        let outcome: Value = outcome
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(json!({"status": status, "command_id": command_id,
            "result": if status == "completed" { outcome.clone() } else { Value::Null },
            "error": if status == "failed" { outcome } else { Value::Null }}))
    }

    fn finish_command(
        &self,
        client_id: &str,
        command_id: &str,
        status: &str,
        outcome: &Value,
    ) -> Result<()> {
        self.connection()?.execute(
            "UPDATE commands SET status=?3,outcome_json=?4,updated_at_ms=?5
             WHERE client_id=?1 AND command_id=?2",
            params![
                client_id,
                command_id,
                status,
                serde_json::to_string(outcome)?,
                now_ms_i64()
            ],
        )?;
        Ok(())
    }

    fn record_message(
        &self,
        message_id: &str,
        from_agent_id: &str,
        to_agent_id: &str,
        body: &str,
    ) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO messages
             (message_id,from_agent_id,to_agent_id,body,status,created_at_ms)
             VALUES (?1,?2,?3,?4,'pending',?5)",
            params![message_id, from_agent_id, to_agent_id, body, now_ms_i64()],
        )?;
        let existing: (String, String, String) = connection.query_row(
            "SELECT from_agent_id,to_agent_id,body FROM messages WHERE message_id=?1",
            params![message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if existing != (from_agent_id.into(), to_agent_id.into(), body.into()) {
            bail!("message_id was already used for different content")
        }
        Ok(())
    }

    fn finish_message(&self, message_id: &str, delivery: &Value) -> Result<()> {
        self.connection()?.execute(
            "UPDATE messages SET status='delivered',delivery_json=?2,delivered_at_ms=?3
             WHERE message_id=?1",
            params![message_id, serde_json::to_string(delivery)?, now_ms_i64()],
        )?;
        Ok(())
    }

    fn acquire_workspace_lease(&self, workspace_id: &str, owner: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            connection.execute(
                "DELETE FROM leases WHERE expires_at_ms IS NOT NULL AND expires_at_ms<=?1",
                params![now_ms_i64()],
            )?;
            let current = connection
                .query_row(
                    "SELECT owner,expires_at_ms FROM leases
                     WHERE resource_type='workspace-write' AND resource_key=?1",
                    params![workspace_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .optional()?;
            if let Some((current_owner, expiry)) = current {
                if current_owner != owner {
                    bail!("workspace write lease is held by {current_owner}")
                }
                if expiry.is_none() {
                    bail!(
                        "workspace has an unresolved worker delivery; reconcile or stop the worker before submitting more work"
                    )
                }
            }
            connection.execute(
                "INSERT INTO leases(resource_type,resource_key,owner,expires_at_ms)
                 VALUES ('workspace-write',?1,?2,?3)
                 ON CONFLICT(resource_type,resource_key) DO UPDATE SET
                   owner=excluded.owner,expires_at_ms=excluded.expires_at_ms",
                params![workspace_id, owner, now_ms_i64() + 60 * 60 * 1000],
            )?;
            Ok(())
        })();
        if result.is_ok() {
            connection.execute_batch("COMMIT")?;
        } else {
            let _ = connection.execute_batch("ROLLBACK");
        }
        result
    }

    fn release_workspace_lease(&self, workspace_id: &str, owner: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM leases WHERE resource_type='workspace-write'
             AND resource_key=?1 AND owner=?2",
            params![workspace_id, owner],
        )?;
        Ok(())
    }

    fn retain_uncertain_workspace_lease(
        &self,
        workspace_id: &str,
        owner: &str,
        request_id: Option<&str>,
    ) -> Result<()> {
        self.connection()?.execute(
            "UPDATE leases SET expires_at_ms=NULL,uncertain_request_id=COALESCE(uncertain_request_id,?3) WHERE resource_type='workspace-write'
             AND resource_key=?1 AND owner=?2",
            params![workspace_id, owner,request_id],
        )?;
        Ok(())
    }

    fn release_workspace_lease_after_run(
        &self,
        workspace_id: &str,
        owner: &str,
        request_id: &str,
    ) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM leases WHERE resource_type='workspace-write' AND resource_key=?1 AND owner=?2
             AND (expires_at_ms IS NOT NULL OR uncertain_request_id=?3)",
            params![workspace_id,owner,request_id])?;
        Ok(())
    }

    fn purge_expired_leases(&self) -> Result<usize> {
        Ok(self.connection()?.execute(
            "DELETE FROM leases WHERE expires_at_ms IS NOT NULL AND expires_at_ms<=?1",
            params![now_ms_i64()],
        )?)
    }

    fn recover_claimed_schedules(&self) -> Result<usize> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT schedule_id,expression,policy_json FROM schedules
             WHERE status='claimed'",
        )?;
        let rows: Vec<(String, String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .filter_map(Result::ok)
            .collect();
        drop(statement);
        let mut recovered = 0;
        for (schedule_id, expression, policy_text) in rows {
            let mut policy: Value = serde_json::from_str(&policy_text).unwrap_or(json!({}));
            if let Some(object) = policy.as_object_mut() {
                object.insert(
                    "last_error".into(),
                    json!("daemon restarted while the tick outcome was uncertain; the tick was not replayed"),
                );
            }
            // Even recurring schedules must wait for reconciliation: a later
            // tick can repeat the same external action as the interrupted tick.
            let _ = expression;
            recovered += connection.execute(
                "UPDATE schedules SET status='uncertain',next_at_ms=NULL,claim=NULL,policy_json=?2,revision=revision+1
                 WHERE schedule_id=?1 AND status='claimed'",
                params![schedule_id, serde_json::to_string(&policy)?],
            )?;
        }
        Ok(recovered)
    }

    fn add_schedule(
        &self,
        agent_id: &str,
        expression: &str,
        next_at_ms: i64,
        policy: &Value,
    ) -> Result<Value> {
        let schedule_id = format!("schedule-{}", Uuid::new_v4());
        self.connection()?.execute(
            "INSERT INTO schedules
             (schedule_id,agent_id,expression,next_at_ms,claim,policy_json,status)
             VALUES (?1,?2,?3,?4,NULL,?5,'active')",
            params![
                schedule_id,
                agent_id,
                expression,
                next_at_ms,
                serde_json::to_string(policy)?
            ],
        )?;
        Ok(json!({
            "schedule_id": schedule_id,
            "agent_id": agent_id,
            "expression": expression,
            "next_at_ms": next_at_ms,
            "policy": policy,
            "status": "active",
            "revision": 1
        }))
    }

    fn list_schedules(&self, agent_id: Option<&str>) -> Result<Vec<Value>> {
        let connection = self.connection()?;
        let sql = if agent_id.is_some() {
            "SELECT schedule_id,agent_id,expression,next_at_ms,claim,policy_json,status,revision
             FROM schedules WHERE agent_id=?1 ORDER BY next_at_ms"
        } else {
            "SELECT schedule_id,agent_id,expression,next_at_ms,claim,policy_json,status,revision
             FROM schedules ORDER BY next_at_ms"
        };
        let mut statement = connection.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            let policy_text: String = row.get(5)?;
            Ok(json!({
                "schedule_id": row.get::<_, String>(0)?,
                "agent_id": row.get::<_, String>(1)?,
                "expression": row.get::<_, String>(2)?,
                "next_at_ms": row.get::<_, Option<i64>>(3)?,
                "claim": row.get::<_, Option<String>>(4)?,
                "policy": serde_json::from_str::<Value>(&policy_text).unwrap_or(Value::Null),
                "status": row.get::<_, String>(6)?,
                "revision": row.get::<_, i64>(7)?,
            }))
        };
        let rows = if let Some(agent_id) = agent_id {
            statement.query_map(params![agent_id], map_row)?
        } else {
            statement.query_map([], map_row)?
        };
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn idle_schedule_pins(&self, agent_ids: &HashSet<String>) -> Result<Vec<String>> {
        Ok(self
            .list_schedules(None)?
            .into_iter()
            .filter(|schedule| {
                schedule
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .is_some_and(|agent_id| agent_ids.contains(agent_id))
                    && schedule
                        .get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| matches!(status, "active" | "claimed" | "paused"))
            })
            .filter_map(|schedule| {
                let id = schedule.get("schedule_id")?.as_str()?;
                let status = schedule.get("status")?.as_str()?;
                Some(format!("schedule:{id}:{status}"))
            })
            .collect())
    }

    fn revise_schedule(
        &self,
        schedule_id: &str,
        revision: i64,
        expression: &str,
        next: Option<i64>,
        policy: &Value,
        status: &str,
    ) -> Result<()> {
        let changed = self.connection()?.execute(
            "UPDATE schedules SET expression=?3,next_at_ms=?4,policy_json=?5,status=?6,
             revision=revision+1,claim=NULL WHERE schedule_id=?1 AND revision=?2",
            params![
                schedule_id,
                revision,
                expression,
                next,
                serde_json::to_string(policy)?,
                status
            ],
        )?;
        if changed != 1 {
            return Err(api_error(
                "revision_conflict",
                "schedule changed; refresh before retrying",
            ));
        }
        Ok(())
    }

    fn revise_goal(
        &self,
        goal_id: &str,
        revision: i64,
        objective: &str,
        max: u64,
        status: &str,
    ) -> Result<()> {
        let changed = self.connection()?.execute(
            "UPDATE goals SET objective=?3,max_continuations=?4,status=?5,updated_at_ms=?6,
             revision=revision+1 WHERE goal_id=?1 AND revision=?2",
            params![
                goal_id,
                revision,
                objective,
                max as i64,
                status,
                now_ms_i64()
            ],
        )?;
        if changed != 1 {
            return Err(api_error(
                "revision_conflict",
                "goal changed; refresh before retrying",
            ));
        }
        Ok(())
    }

    fn claim_due_schedule(&self) -> Result<Option<ScheduleClaim>> {
        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let selected = connection
            .query_row(
                "SELECT schedule_id,agent_id,expression,policy_json
                 FROM schedules WHERE status='active' AND next_at_ms<=?1
                 ORDER BY next_at_ms LIMIT 1",
                params![now_ms_i64()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((schedule_id, agent_id, expression, policy_text)) = selected else {
            connection.execute_batch("COMMIT")?;
            return Ok(None);
        };
        let claim = format!("claim-{}", Uuid::new_v4());
        let mut policy: Value = serde_json::from_str(&policy_text)?;
        let object = policy
            .as_object_mut()
            .context("schedule policy must be an object")?;
        let delivery_id = object
            .get("delivery_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("schedule-delivery-{}", Uuid::new_v4()));
        object.insert("delivery_id".into(), json!(delivery_id));
        let updated = connection.execute(
            "UPDATE schedules SET status='claimed',claim=?2,policy_json=?3,revision=revision+1
             WHERE schedule_id=?1 AND status='active'",
            params![schedule_id, claim, serde_json::to_string(&policy)?],
        )?;
        if updated == 0 {
            connection.execute_batch("ROLLBACK")?;
            return Ok(None);
        }
        connection.execute_batch("COMMIT")?;
        Ok(Some(ScheduleClaim {
            schedule_id,
            agent_id,
            expression,
            policy,
            claim,
            delivery_id,
        }))
    }

    fn finish_schedule_claim(
        &self,
        claim: &ScheduleClaim,
        status: &str,
        next_at_ms: Option<i64>,
        policy: &Value,
    ) -> Result<()> {
        self.connection()?.execute(
            "UPDATE schedules SET status=?3,next_at_ms=?4,policy_json=?5,claim=NULL,revision=revision+1
             WHERE schedule_id=?1 AND claim=?2",
            params![
                claim.schedule_id,
                claim.claim,
                status,
                next_at_ms,
                serde_json::to_string(policy)?
            ],
        )?;
        Ok(())
    }

    fn create_goal(&self, agent_id: &str, objective: &str, max: u64) -> Result<Value> {
        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let unfinished: i64 = connection.query_row(
            "SELECT COUNT(*) FROM goals WHERE agent_id=?1 AND status IN ('active','paused','blocked','uncertain','budget_exhausted')",
            params![agent_id], |row| row.get(0))?;
        if unfinished > 0 {
            bail!(
                "agent already has an unfinished goal; complete or cancel it before creating another"
            )
        }
        let goal_id = format!("goal-{}", Uuid::new_v4());
        connection.execute(
            "INSERT INTO goals
             (goal_id,agent_id,objective,status,continuation_count,max_continuations,
              created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,'active',0,?4,?5,?5)",
            params![goal_id, agent_id, objective, max as i64, now_ms_i64()],
        )?;
        connection.execute_batch("COMMIT")?;
        Ok(json!({
            "goal_id": goal_id,
            "agent_id": agent_id,
            "objective": objective,
            "status": "active",
            "continuation_count": 0,
            "max_continuations": max,
            "revision": 1,
        }))
    }

    fn list_goals(&self, agent_id: Option<&str>) -> Result<Vec<Value>> {
        let connection = self.connection()?;
        let sql = if agent_id.is_some() {
            "SELECT goal_id,agent_id,objective,status,continuation_count,
                    max_continuations,last_request_id,last_error,created_at_ms,updated_at_ms,revision
             FROM goals WHERE agent_id=?1 ORDER BY created_at_ms DESC"
        } else {
            "SELECT goal_id,agent_id,objective,status,continuation_count,
                    max_continuations,last_request_id,last_error,created_at_ms,updated_at_ms,revision
             FROM goals ORDER BY created_at_ms DESC"
        };
        let mut statement = connection.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            Ok(json!({
                "goal_id": row.get::<_, String>(0)?,
                "agent_id": row.get::<_, String>(1)?,
                "objective": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "continuation_count": row.get::<_, i64>(4)?,
                "max_continuations": row.get::<_, i64>(5)?,
                "last_request_id": row.get::<_, Option<String>>(6)?,
                "last_error": row.get::<_, Option<String>>(7)?,
                "created_at_ms": row.get::<_, i64>(8)?,
                "updated_at_ms": row.get::<_, i64>(9)?,
                "revision": row.get::<_, i64>(10)?,
            }))
        };
        let rows = if let Some(agent_id) = agent_id {
            statement.query_map(params![agent_id], map_row)?
        } else {
            statement.query_map([], map_row)?
        };
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn record_goal_run(&self, goal_id: &str, request_id: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO goal_runs(request_id,goal_id,status,created_at_ms)
             VALUES (?1,?2,'running',?3)",
            params![request_id, goal_id, now_ms_i64()],
        )?;
        connection.execute(
            "UPDATE goals SET last_request_id=?2,updated_at_ms=?3,revision=revision+1 WHERE goal_id=?1",
            params![goal_id, request_id, now_ms_i64()],
        )?;
        Ok(())
    }

    fn finish_goal_run(&self, request_id: &str) -> Result<Option<GoalContinuation>> {
        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let selected = connection
            .query_row(
                "SELECT g.goal_id,g.agent_id,g.objective,g.continuation_count,
                        g.max_continuations,g.status
                 FROM goal_runs r JOIN goals g ON g.goal_id=r.goal_id
                 WHERE r.request_id=?1 AND r.status='running'",
                params![request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?.max(0) as u64,
                        row.get::<_, i64>(4)?.max(0) as u64,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((goal_id, agent_id, objective, count, max, status)) = selected else {
            connection.execute_batch("COMMIT")?;
            return Ok(None);
        };
        connection.execute(
            "UPDATE goal_runs SET status='completed',completed_at_ms=?2 WHERE request_id=?1",
            params![request_id, now_ms_i64()],
        )?;
        let continuation = if status != "active" {
            None
        } else if count >= max {
            connection.execute(
                "UPDATE goals SET status='budget_exhausted',updated_at_ms=?2,revision=revision+1
                 WHERE goal_id=?1",
                params![goal_id, now_ms_i64()],
            )?;
            None
        } else {
            let next = count + 1;
            connection.execute(
                "UPDATE goals SET continuation_count=?2,updated_at_ms=?3,revision=revision+1 WHERE goal_id=?1",
                params![goal_id, next as i64, now_ms_i64()],
            )?;
            Some(GoalContinuation {
                previous_request_id: Some(request_id.to_owned()),
                goal_id,
                agent_id,
                objective,
                continuation_count: next,
                max_continuations: max,
            })
        };
        connection.execute_batch("COMMIT")?;
        Ok(continuation)
    }

    fn goal_id_for_run(&self, request_id: &str) -> Result<Option<String>> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT goal_id FROM goal_runs WHERE request_id=?1",
                params![request_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn finish_goal_run_failed(&self, request_id: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE goal_runs SET status='failed',completed_at_ms=?2
             WHERE request_id=?1 AND status='running'",
            params![request_id, now_ms_i64()],
        )?;
        Ok(())
    }

    fn mark_goal_error(&self, goal_id: &str, error: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE goals SET status='blocked',last_error=?2,updated_at_ms=?3,revision=revision+1
             WHERE goal_id=?1 AND status='active'",
            params![goal_id, error, now_ms_i64()],
        )?;
        Ok(())
    }

    fn record_task(&self, agent_id: &str, request_id: &str) -> Result<String> {
        let task_id = format!("task-{}", Uuid::new_v4());
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM tasks WHERE run_id=?1 AND status='failed'",
            params![request_id],
        )?;
        connection.execute(
            "INSERT INTO tasks(task_id,agent_id,run_id,status,created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,'running',?4,?4)",
            params![task_id, agent_id, request_id, now_ms_i64()],
        )?;
        Ok(task_id)
    }

    fn finish_task(&self, request_id: &str, ok: bool) -> Result<()> {
        self.connection()?.execute(
            "UPDATE tasks SET status=?2,updated_at_ms=?3 WHERE run_id=?1",
            params![
                request_id,
                if ok { "completed" } else { "failed" },
                now_ms_i64()
            ],
        )?;
        Ok(())
    }

    fn has_running_task(&self, agent_ids: &HashSet<String>) -> Result<bool> {
        let connection = self.connection()?;
        for agent_id in agent_ids {
            if connection
                .query_row(
                    "SELECT 1 FROM tasks WHERE agent_id=?1 AND status='running' LIMIT 1",
                    params![agent_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn mark_interrupted_agent_work_uncertain(&self, agent_id: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            connection.execute(
                "UPDATE tasks SET status='uncertain',updated_at_ms=?2
                 WHERE agent_id=?1 AND status='running'",
                params![agent_id, now_ms_i64()],
            )?;
            connection.execute(
                "UPDATE goal_runs SET status='uncertain',completed_at_ms=?2
                 WHERE status='running' AND goal_id IN
                   (SELECT goal_id FROM goals WHERE agent_id=?1)",
                params![agent_id, now_ms_i64()],
            )?;
            connection.execute(
                "UPDATE goals SET status='uncertain',
                   last_error='machine restart interrupted a run; inspect side effects before continuing',
                   updated_at_ms=?2,revision=revision+1
                 WHERE agent_id=?1 AND status IN ('active','paused')",
                params![agent_id, now_ms_i64()],
            )?;
            Ok(())
        })();
        if result.is_ok() {
            connection.execute_batch("COMMIT")?;
        } else {
            let _ = connection.execute_batch("ROLLBACK");
        }
        result
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    migration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    drop(statement);
    if !columns.iter().any(|existing| existing == column) {
        connection.execute_batch(migration)?;
    }
    Ok(())
}

fn quick_check(connection: &Connection) -> Result<String> {
    connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(Into::into)
}

fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn protect_sqlite_files(path: &Path) -> Result<()> {
    for candidate in [
        path.to_path_buf(),
        sqlite_sidecar(path, "-wal"),
        sqlite_sidecar(path, "-shm"),
    ] {
        if candidate.exists() {
            set_owner_only_file(&candidate)?;
        }
    }
    Ok(())
}

fn prune_database_backups(directory: &Path, keep: usize) -> Result<()> {
    let mut backups = fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("supervisor-")
                && entry.file_name().to_string_lossy().ends_with(".sqlite")
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    backups.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    let remove_count = backups.len().saturating_sub(keep);
    for backup in backups.into_iter().take(remove_count) {
        fs::remove_file(backup)?;
    }
    Ok(())
}

fn configured_log_max_bytes() -> u64 {
    env_var("QI_AGENT_LOG_MAX_BYTES", "DAO_LOG_MAX_BYTES")
        .and_then(|value| value.parse().ok())
        .filter(|value| *value >= 64 * 1024)
        .unwrap_or(DEFAULT_LOG_MAX_BYTES)
}

fn configured_log_backups() -> usize {
    env_var("QI_AGENT_LOG_BACKUPS", "DAO_LOG_BACKUPS")
        .and_then(|value| value.parse().ok())
        .filter(|value| (1..=20).contains(value))
        .unwrap_or(DEFAULT_LOG_BACKUPS)
}

fn configured_max_worker_logs() -> usize {
    env_var("QI_AGENT_MAX_WORKER_LOGS", "DAO_MAX_WORKER_LOGS")
        .and_then(|value| value.parse().ok())
        .filter(|value| (10..=10_000).contains(value))
        .unwrap_or(DEFAULT_MAX_WORKER_LOGS)
}

fn rotate_log_if_needed(path: &Path, max_bytes: u64, backups: usize) -> Result<bool> {
    if !path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= max_bytes)
    {
        return Ok(false);
    }
    for index in (1..backups).rev() {
        let source = path.with_extension(format!("log.{index}"));
        let destination = path.with_extension(format!("log.{}", index + 1));
        if source.exists() {
            if destination.exists() {
                fs::remove_file(&destination)?;
            }
            fs::rename(source, destination)?;
        }
    }
    let first = path.with_extension("log.1");
    if first.exists() {
        fs::remove_file(&first)?;
    }
    fs::rename(path, first)?;
    Ok(true)
}

fn prune_worker_logs(directory: &Path, keep: usize) -> Result<usize> {
    let mut logs = fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().starts_with("worker-")
                && entry.file_name().to_string_lossy().contains(".log")
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    for log in &logs {
        set_owner_only_file(log)?;
    }
    logs.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    let remove_count = logs.len().saturating_sub(keep);
    for log in logs.into_iter().take(remove_count) {
        fs::remove_file(log)?;
    }
    Ok(remove_count)
}

pub fn serve(repository_root: Option<&Path>, config_path: Option<&Path>) -> Result<()> {
    let owner_value = std::env::var("QI_AGENT_DESKTOP_PARENT_PID").ok();
    let desktop_parent = crate::desktop_owner::validate_parent(owner_value.as_deref(), unsafe {
        libc::getppid() as u32
    })?;
    let desktop_run = if desktop_parent.is_some() {
        let id =
            std::env::var("QI_AGENT_DESKTOP_RUN_ID").context("desktop run identity missing")?;
        Uuid::parse_str(&id)?;
        Some(id)
    } else {
        None
    };
    let paths = RuntimePaths::discover()?;
    // This lease survives a shell crash until the old daemon has stopped its
    // workers. A new temporary socket directory cannot bypass the same state.
    let _desktop_lease = if desktop_parent.is_some() {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(paths.state_dir.join("desktop-daemon.lock"))?;
        set_owner_only_file(&paths.state_dir.join("desktop-daemon.lock"))?;
        file.try_lock_exclusive()
            .context("the previous desktop daemon is still stopping")?;
        Some(file)
    } else {
        None
    };
    prune_worker_logs(&paths.logs_dir, configured_max_worker_logs())?;
    let repository_root = discover_repository_root(repository_root)?;
    let config_path = config_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repository_root.join("agent.edn"));
    let config_path = canonical(config_path)?;
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&paths.daemon_lock)?;
    lock_file
        .try_lock_exclusive()
        .context("another qi-agent daemon already owns the launch lease")?;
    if UnixStream::connect(&paths.public_socket).is_ok() {
        bail!("qi-agent daemon is already running")
    }
    if paths.public_socket.exists() {
        fs::remove_file(&paths.public_socket)?;
    }
    let listener = UnixListener::bind(&paths.public_socket).with_context(|| {
        format!(
            "could not bind daemon socket {}",
            paths.public_socket.display()
        )
    })?;
    set_owner_only_file(&paths.public_socket)?;
    listener.set_nonblocking(true)?;

    let database = Database::new(paths.database.clone())?;
    database.recover_claimed_schedules()?;
    let runtime = Arc::new(Runtime {
        paths: paths.clone(),
        repository_root,
        config_path,
        database,
        agents: Mutex::new(HashMap::new()),
        workers: Mutex::new(HashMap::new()),
        residency: Mutex::new(()),
        shutdown: AtomicBool::new(false),
        desktop_owned: desktop_parent.is_some(),
        desktop_startup_unknown: AtomicBool::new(false),
        idle_sweep_running: AtomicBool::new(false),
        last_idle_sweep_at_ms: AtomicU64::new(0),
        next_idle_sweep_at_ms: AtomicU64::new(0),
    });
    if let Some(parent) = desktop_parent {
        let weak = Arc::downgrade(&runtime);
        thread::spawn(move || {
            while let Some(runtime) = weak.upgrade() {
                if unsafe { libc::getppid() as u32 } != parent {
                    runtime.shutdown.store(true, Ordering::SeqCst);
                    break;
                }
                if runtime.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                drop(runtime);
                thread::sleep(Duration::from_millis(100));
            }
        });
    }
    runtime.restore_agents()?;
    runtime.recover_session_archives();
    runtime.adopt_workers();
    runtime.recover_missing_workers();
    spawn_scheduler(Arc::clone(&runtime));
    spawn_idle_sweeper(Arc::clone(&runtime));

    while !runtime.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                let runtime = Arc::clone(&runtime);
                thread::spawn(move || {
                    if let Err(error) = handle_client(runtime, stream) {
                        eprintln!("qi-agent client connection failed: {error:#}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error).context("daemon socket accept failed"),
        }
    }

    let cleanup_errors = runtime.stop_all_workers_checked();
    if let Some(run_id) = desktop_run {
        crate::desktop_owner::shutdown_receipt(&paths.runtime_dir, &run_id, &cleanup_errors)?;
        if !cleanup_errors.is_empty() {
            bail!("desktop worker cleanup incomplete; retained descriptors require reconciliation");
        }
    }
    let _ = fs::remove_file(&paths.public_socket);
    drop(lock_file);
    Ok(())
}

impl Runtime {
    fn retain_failed_desktop_start(&self, descriptor: &Path, pid: Option<u32>) -> bool {
        let Some(pid) = pid.filter(|_| self.desktop_owned) else {
            return false;
        };
        self.desktop_startup_unknown.store(true, Ordering::SeqCst);
        self.shutdown.store(true, Ordering::SeqCst);
        // Keep the agent, preset and ordinary descriptor. An immutable private
        // identity copy survives best-effort cleanup; any write failure still
        // leaves the sticky UNKNOWN gate and prevents a successful receipt.
        let _ =
            crate::desktop_owner::failed_start_identity(&self.paths.runtime_dir, descriptor, pid);
        if let Ok(mut value) = read_descriptor(descriptor) {
            value.pid = value.pid.or(Some(pid));
            let _ = write_descriptor(descriptor, &value);
        }
        true
    }

    fn list_presets(&self) -> Result<Value> {
        // This bb helper is a daemon child too. Drain it before a desktop
        // cleanup receipt; materialization already runs under create's gate.
        let _desktop_process = if self.desktop_owned {
            Some(crate::desktop_owner::process_admission(
                true,
                &self.shutdown,
                &self.residency,
            )?)
        } else {
            None
        };
        let expression = r#"
(require '[qi.presets :as presets]
         '[cheshire.core :as json]
         '[clojure.java.io :as io])
(let [root (or (System/getenv "QI_AGENT_REPOSITORY_ROOT")
               (System/getenv "DAO_REPOSITORY_ROOT"))
      home (or (System/getenv "QI_AGENT_HOME")
               (str (io/file (System/getProperty "user.home") ".qi-agent")))
      registry (presets/create-registry
                {:system-roots [(str (io/file root "presets"))]
                 :user-root (or (System/getenv "QI_AGENT_PRESET_USER_ROOT")
                                (System/getenv "DAO_PRESET_USER_ROOT")
                                (str (io/file home "presets")))})
      public-preset (fn [preset]
                      (cond-> (select-keys preset [:id :name :description :order :trust])
                        (:broken preset) (assoc :broken true)))]
  (print (json/generate-string
          (mapv public-preset (presets/list-presets registry)))))
"#;
        let output = Command::new("bb")
            .arg("-cp")
            .arg(self.repository_root.join("src"))
            .arg("-e")
            .arg(expression)
            .current_dir(&self.repository_root)
            .env("QI_AGENT_REPOSITORY_ROOT", &self.repository_root)
            .env("DAO_REPOSITORY_ROOT", &self.repository_root)
            .output()
            .context("could not invoke the Preset registry")?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(api_error(
                "preset_registry_unavailable",
                format!("Presets could not be listed: {}", detail.trim()),
            ));
        }
        serde_json::from_slice(&output.stdout)
            .context("Preset registry returned an invalid list response")
    }

    fn materialize_preset_config(&self, preset_id: &str, worker_id: &str) -> Result<PathBuf> {
        if preset_id.len() > 128 || !valid_preset_id(preset_id) {
            return Err(api_error(
                "invalid_preset_id",
                format!("invalid preset_id: {preset_id}"),
            ));
        }
        let expression = r#"
(require '[qi.presets :as presets]
         '[cheshire.core :as json]
         '[clojure.java.io :as io])
(let [root (or (System/getenv "QI_AGENT_REPOSITORY_ROOT")
               (System/getenv "DAO_REPOSITORY_ROOT"))
      home (or (System/getenv "QI_AGENT_HOME")
               (str (io/file (System/getProperty "user.home") ".qi-agent")))
      registry (presets/create-registry
                {:system-roots [(str (io/file root "presets"))]
                 :user-root (or (System/getenv "QI_AGENT_PRESET_USER_ROOT")
                                (System/getenv "DAO_PRESET_USER_ROOT")
                                (str (io/file home "presets")))})]
  (print
   (json/generate-string
    (try
      {:ok true
       :result (presets/materialize-preset registry
                                           (System/getenv "QI_AGENT_PRESET_ID"))}
      (catch Throwable error
        {:ok false
         :error {:type (some-> (ex-data error) :type name)
                 :message (ex-message error)}})))))
"#;
        let output = Command::new("bb")
            .arg("-cp")
            .arg(self.repository_root.join("src"))
            .arg("-e")
            .arg(expression)
            .current_dir(&self.repository_root)
            .env("QI_AGENT_REPOSITORY_ROOT", &self.repository_root)
            .env("QI_AGENT_PRESET_ID", preset_id)
            .env("DAO_REPOSITORY_ROOT", &self.repository_root)
            .env("DAO_PRESET_ID", preset_id)
            .output()
            .context("could not invoke the Preset registry")?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(api_error(
                "preset_registry_unavailable",
                format!("preset_id could not be resolved: {}", detail.trim()),
            ));
        }
        let response: Value = serde_json::from_slice(&output.stdout)
            .context("Preset registry returned an invalid materialization response")?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let error = response.get("error").unwrap_or(&Value::Null);
            let code = error
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("preset_resolution_failed")
                .replace('-', "_");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Preset registry rejected the requested preset");
            return Err(api_error(code, message));
        }
        let materialized = response.get("result").unwrap_or(&Value::Null);
        let config = materialized
            .get("config")
            .and_then(Value::as_str)
            .context("Preset registry did not return a config snapshot")?;
        if config.len() > 1_048_576 {
            return Err(api_error(
                "preset_config_too_large",
                "materialized Preset config is too large",
            ));
        }
        let snapshot = self
            .paths
            .workers_dir
            .join(format!("{worker_id}.agent.edn"));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&snapshot)
            .with_context(|| format!("could not create Preset snapshot {}", snapshot.display()))?;
        file.write_all(config.as_bytes())?;
        file.flush()?;
        set_owner_only_file(&snapshot)?;
        canonical(snapshot)
    }

    fn restore_agents(&self) -> Result<()> {
        let values = self.database.load_agents()?;
        let mut agents = self.agents.lock().expect("agents mutex poisoned");
        for value in values {
            agents.insert(value.agent_id.clone(), value);
        }
        Ok(())
    }

    fn adopt_workers(self: &Arc<Self>) {
        let Ok(entries) = fs::read_dir(&self.paths.workers_dir) else {
            return;
        };
        for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(descriptor) = read_descriptor(&path) else {
                continue;
            };
            let Ok(residency) = crate::desktop_owner::process_admission(
                self.desktop_owned,
                &self.shutdown,
                &self.residency,
            ) else {
                return;
            };
            if self
                .agents
                .lock()
                .expect("agents mutex poisoned")
                .get(&descriptor.agent_id)
                .is_some_and(|agent| matches!(agent.status.as_str(), "stopped" | "inactive"))
            {
                continue;
            }
            if self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .get(&descriptor.worker_id)
                .is_some_and(|worker| worker.alive.load(Ordering::SeqCst))
            {
                continue;
            }
            if descriptor.status != "running" || !process_alive(descriptor.pid) {
                continue;
            }
            if let Ok(worker) = connect_worker(descriptor.clone(), self.database.clone()) {
                self.workers
                    .lock()
                    .expect("workers mutex poisoned")
                    .insert(descriptor.worker_id.clone(), Arc::clone(&worker));
                let _ = self.database.upsert_worker(&descriptor, &path);
                // A registered worker may already be stopping. Never wait on
                // its lifecycle while holding the residency or agent registry.
                drop(residency);
                let summary = worker
                    .call("session.summary", json!({}), Duration::from_millis(750))
                    .ok();
                if let Some(agent) = self
                    .agents
                    .lock()
                    .expect("agents mutex poisoned")
                    .get_mut(&descriptor.agent_id)
                    && !matches!(agent.status.as_str(), "stopped" | "inactive")
                {
                    agent.status = "idle".into();
                    agent.session_id = descriptor.session_id.clone();
                    agent.inactive_reason = None;
                    if let Some(summary) = summary {
                        apply_session_summary(agent, &summary);
                    }
                    let _ = self.database.upsert_agent(agent);
                }
            }
        }
    }

    fn recover_missing_workers(self: &Arc<Self>) {
        let active_worker_ids: Vec<_> = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .iter()
            .filter(|(_, worker)| worker.alive.load(Ordering::SeqCst))
            .map(|(id, _)| id.clone())
            .collect();
        let agents: Vec<_> = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .filter(|agent| {
                !active_worker_ids.contains(&agent.worker_id)
                    && !matches!(agent.status.as_str(), "stopped" | "inactive")
            })
            .cloned()
            .collect();
        for agent in agents {
            if let Err(error) = self.hydrate_root(&agent.agent_id) {
                eprintln!("worker recovery failed for {}: {error:#}", agent.agent_id);
            }
        }
    }

    fn create_agent(self: &Arc<Self>, parameters: &Value) -> Result<Value> {
        if configured_idle_eviction().is_some()
            && self.workers.lock().expect("workers mutex poisoned").len()
                >= configured_max_workers()
        {
            self.sweep_idle_workers_with_threshold(Duration::ZERO, true)?;
        }
        let _residency = crate::desktop_owner::process_admission(
            self.desktop_owned,
            &self.shutdown,
            &self.residency,
        )?;
        let max_workers = configured_max_workers();
        if self.workers.lock().expect("workers mutex poisoned").len() >= max_workers {
            bail!("worker quota reached ({max_workers}); stop an agent before creating another")
        }
        let workspace_value = parameters
            .get("workspace")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let workspace_path = canonical(workspace_value)?;
        if parameters
            .get("config_path")
            .is_some_and(|value| !value.is_null())
        {
            return Err(api_error(
                "config_path_not_allowed",
                "agent.create does not accept config_path; use preset_id",
            ));
        }
        let preset_id = match parameters.get("preset_id") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => {
                return Err(api_error(
                    "invalid_preset_id_type",
                    "preset_id must be a string",
                ));
            }
        };
        let repl_backend = parameters
            .get("repl_backend")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if repl_backend
            .as_deref()
            .is_some_and(|backend| !matches!(backend, "babashka" | "jvm-clojure"))
        {
            bail!("repl_backend must be babashka or jvm-clojure")
        }
        let workspace_id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            workspace_path.to_string_lossy().as_bytes(),
        )
        .to_string();
        let agent_id = format!("agent-{}", Uuid::new_v4());
        let worker_id = format!("worker-{}", Uuid::new_v4());
        let session_path =
            if let Some(path) = parameters.get("session_path").and_then(Value::as_str) {
                let value = PathBuf::from(path);
                if value.is_absolute() {
                    value
                } else {
                    workspace_path.join(value)
                }
            } else {
                workspace_path.join(format!(
                    ".qi-agent/sessions/{}-{}.jsonl",
                    now_ms(),
                    &Uuid::new_v4().to_string()[..8]
                ))
            };
        let session_path = normalize_session_path(&session_path)?;
        if self.database.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_archives WHERE source_path=?1 OR archive_path=?1)",
            params![session_path.to_string_lossy()],
            |row| row.get::<_, bool>(0),
        )? {
            bail!("session is archived; the original path cannot be reopened")
        }
        if let Some(parent) = session_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let config_path = preset_id
            .as_deref()
            .map(|id| self.materialize_preset_config(id, &worker_id))
            .transpose()?
            .unwrap_or_else(|| self.config_path.clone());
        let preset_snapshot = preset_id.as_ref().map(|_| config_path.clone());
        let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
        let mut descriptor = WorkerDescriptor::new(
            &self.paths,
            worker_id.clone(),
            agent_id.clone(),
            workspace_id.clone(),
            workspace_path.clone(),
            session_path.clone(),
            self.repository_root.clone(),
            config_path,
            token,
        );
        descriptor.preset_id = preset_id.clone();
        descriptor.repl_backend = repl_backend;
        let descriptor_path = self.paths.worker_descriptor(&worker_id);
        if let Err(error) = write_descriptor(&descriptor_path, &descriptor) {
            if let Some(path) = &preset_snapshot {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        let agent = AgentRecord {
            agent_id: agent_id.clone(),
            root_agent_id: agent_id.clone(),
            workspace_id,
            workspace_path,
            session_id: None,
            session_path,
            worker_id: worker_id.clone(),
            preset_id,
            name: parameters
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: "starting".into(),
            controller_client_id: None,
            created_at_ms: now_ms(),
            lifecycle: "draft".into(),
            last_activity_at_ms: None,
            inactive_reason: None,
        };
        if let Err(error) = self.database.upsert_agent(&agent) {
            let _ = fs::remove_file(&descriptor_path);
            if let Some(path) = &preset_snapshot {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .insert(agent_id.clone(), agent);

        let mut spawned_pid = None;
        let startup = (|| -> Result<_> {
            spawned_pid = Some(spawn_worker_proxy(&descriptor_path)?);
            let connected_descriptor = wait_for_worker(&descriptor_path, Duration::from_secs(20))?;
            let worker = connect_worker(connected_descriptor.clone(), self.database.clone())?;
            self.database
                .upsert_worker(&connected_descriptor, &descriptor_path)?;
            let snapshot = worker.call("session.snapshot", json!({}), WORKER_RPC_TIMEOUT)?;
            let summary = worker.call("session.summary", json!({}), WORKER_RPC_TIMEOUT)?;
            Ok((connected_descriptor, worker, snapshot, summary))
        })();
        let (connected_descriptor, worker, snapshot, summary) = match startup {
            Ok(started) => started,
            Err(error) => {
                if self.retain_failed_desktop_start(&descriptor_path, spawned_pid) {
                    return Err(error).context("desktop worker startup UNKNOWN; identity retained and automatic restart blocked");
                }
                self.agents
                    .lock()
                    .expect("agents mutex poisoned")
                    .remove(&agent_id);
                let _ = self
                    .database
                    .remove_failed_agent_start(&agent_id, &worker_id);
                terminate_failed_worker_start(&descriptor_path, true, spawned_pid);
                if let Some(path) = &preset_snapshot {
                    let _ = fs::remove_file(path);
                }
                return Err(error).context("could not start resident worker");
            }
        };
        self.workers
            .lock()
            .expect("workers mutex poisoned")
            .insert(worker_id, Arc::clone(&worker));
        let snapshot_sequence = worker.sequence.load(Ordering::SeqCst);
        {
            let mut agents = self.agents.lock().expect("agents mutex poisoned");
            let current = agents
                .get_mut(&agent_id)
                .context("new agent disappeared during startup")?;
            current.session_id = snapshot
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            current.status = phase_from_snapshot(&snapshot);
            apply_session_summary(current, &summary);
            self.database.upsert_agent(current)?;
        }
        // Startup owns residency only until the worker is published. Public
        // inspection can wait on an existing worker's lifecycle or rehydrate
        // after a crash, neither of which may run under this lock.
        drop(_residency);
        let mut result = json!({"agent": self.public_agent(&agent_id)?});
        if parameters.get("include_snapshot").and_then(Value::as_bool) != Some(false) {
            result["snapshot"] = decorate_snapshot(
                &connected_descriptor,
                worker.generation.load(Ordering::SeqCst),
                &agent_id,
                snapshot_sequence,
                snapshot,
            );
        }
        Ok(result)
    }

    fn submit_turn(
        &self,
        agent_id: &str,
        parameters: Value,
        goal_id: Option<&str>,
    ) -> Result<Value> {
        self.submit_turn_with_id(agent_id, parameters, goal_id, None)
    }

    fn submit_turn_with_id(
        &self,
        agent_id: &str,
        mut parameters: Value,
        goal_id: Option<&str>,
        delivery_id: Option<&str>,
    ) -> Result<Value> {
        validate_turn_message(
            parameters
                .get("message")
                .context("turn.submit requires message")?,
        )?;
        enforce_model_quotas(&parameters)?;
        let worker = self.worker_for_agent(agent_id)?;
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        let _lifecycle = worker
            .lifecycle
            .lock()
            .expect("worker lifecycle mutex poisoned");
        self.database
            .acquire_workspace_lease(&worker.descriptor.workspace_id, &root_agent_id)?;
        let request_id = delivery_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        parameters
            .as_object_mut()
            .context("turn parameters must be an object")?
            .insert("request_id".into(), json!(request_id));
        // Persist admission before the worker can emit a fast run-result.
        let admission = self
            .database
            .record_task(agent_id, &request_id)
            .and_then(|_| {
                if let Some(goal_id) = goal_id {
                    self.database.record_goal_run(goal_id, &request_id)?;
                }
                Ok(())
            });
        if let Err(error) = admission {
            let _ = self.database.finish_task(&request_id, false);
            let _ = self
                .database
                .release_workspace_lease(&worker.descriptor.workspace_id, &root_agent_id);
            return Err(error);
        }
        let result = if root_agent_id == agent_id {
            worker.call_inner("turn.submit", parameters, WORKER_RPC_TIMEOUT)
        } else {
            worker.call_inner(
                "subagent.invoke",
                json!({
                    "agent_id": agent_id,
                    "method": "turn.submit",
                    "params": parameters,
                }),
                WORKER_RPC_TIMEOUT,
            )
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if !uncertain_worker_failure(&error.to_string()) {
                    let _ = self.database.finish_task(&request_id, false);
                    let _ = self.database.finish_goal_run_failed(&request_id);
                    let _ = self
                        .database
                        .release_workspace_lease(&worker.descriptor.workspace_id, &root_agent_id);
                } else {
                    let _ = self.database.retain_uncertain_workspace_lease(
                        &worker.descriptor.workspace_id,
                        &root_agent_id,
                        Some(&request_id),
                    );
                }
                return Err(error);
            }
        };
        let returned_id = result.get("request_id").and_then(Value::as_str);
        if returned_id != Some(request_id.as_str()) {
            let _ = self.database.retain_uncertain_workspace_lease(
                &worker.descriptor.workspace_id,
                &root_agent_id,
                Some(&request_id),
            );
            bail!("worker accepted a different request id; outcome is uncertain")
        }
        Ok(result)
    }

    fn list_agents(&self) -> Vec<Value> {
        let agents = self.agents.lock().expect("agents mutex poisoned");
        let mut values: Vec<_> = agents
            .values()
            .map(|agent| {
                let mut value = public_agent_value(agent);
                if let Ok(descriptor) =
                    read_descriptor(&self.paths.worker_descriptor(&agent.worker_id))
                {
                    decorate_public_agent_descriptor(&mut value, &descriptor);
                }
                value
            })
            .collect();
        drop(agents);
        let workers: Vec<_> = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .values()
            .cloned()
            .collect();
        for worker in &workers {
            let summary = worker
                .call("session.summary", json!({}), Duration::from_millis(750))
                .ok();
            for value in &mut values {
                if value.get("worker_id").and_then(Value::as_str)
                    == Some(worker.descriptor.worker_id.as_str())
                {
                    decorate_public_agent_runtime(value, worker);
                    if let Some(summary) = &summary {
                        decorate_public_agent_summary(value, summary);
                    }
                }
            }
            if let Ok(status) =
                worker.call("subagent.status", json!({}), Duration::from_millis(750))
            {
                for child in status
                    .get("jobs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    values.push(child_agent_value(
                        &worker.descriptor,
                        worker.generation.load(Ordering::SeqCst),
                        child,
                    ));
                }
            }
        }
        values.sort_by_key(|value| {
            std::cmp::Reverse(
                value
                    .get("created_at_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        });
        values
    }

    fn public_agent(&self, agent_id: &str) -> Result<Value> {
        let root_value = {
            let agents = self.agents.lock().expect("agents mutex poisoned");
            agents.get(agent_id).map(public_agent_value)
        };
        if let Some(mut value) = root_value {
            if let Ok(worker) = self.worker_for_agent(agent_id) {
                decorate_public_agent_runtime(&mut value, &worker);
                if let Ok(summary) =
                    worker.call("session.summary", json!({}), Duration::from_millis(750))
                {
                    decorate_public_agent_summary(&mut value, &summary);
                }
            }
            return Ok(value);
        }
        let (worker, child) = self
            .find_child(agent_id)?
            .with_context(|| format!("agent was not found: {agent_id}"))?;
        Ok(child_agent_value(
            &worker.descriptor,
            worker.generation.load(Ordering::SeqCst),
            &child,
        ))
    }

    fn worker_for_agent(&self, agent_id: &str) -> Result<Arc<WorkerConnection>> {
        let root = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get(agent_id)
            .cloned();
        if let Some(root) = root {
            if root.status == "stopped" {
                bail!("agent is archived/stopped and must be explicitly resumed")
            }
            if let Some(worker) = self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .get(&root.worker_id)
                .filter(|worker| worker.alive.load(Ordering::SeqCst))
                .cloned()
            {
                return Ok(worker);
            }
            return self.hydrate_root(&root.agent_id);
        }
        if let Some((worker, _)) = self.find_child(agent_id)? {
            return Ok(worker);
        }
        if let Some(root_id) = self.inactive_root_for_child(agent_id) {
            self.hydrate_root(&root_id)?;
            if let Some((worker, _)) = self.find_child(agent_id)? {
                return Ok(worker);
            }
        }
        bail!("agent was not found: {agent_id}")
    }

    fn inactive_root_for_child(&self, agent_id: &str) -> Option<String> {
        let roots: Vec<_> = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .filter(|agent| agent.status == "inactive")
            .cloned()
            .collect();
        roots.into_iter().find_map(|root| {
            let session_id = root.session_id.as_deref()?;
            let metadata = root.session_path.parent()?.parent()?;
            let roster = metadata
                .join("artifacts")
                .join(session_id)
                .join("children.edn");
            fs::read_to_string(roster)
                .ok()
                .filter(|content| content.contains(agent_id))
                .map(|_| root.agent_id)
        })
    }

    fn hydrate_root(&self, agent_id: &str) -> Result<Arc<WorkerConnection>> {
        if configured_idle_eviction().is_some()
            && self.workers.lock().expect("workers mutex poisoned").len()
                >= configured_max_workers()
        {
            self.sweep_idle_workers_with_threshold(Duration::ZERO, true)?;
        }
        let _residency = crate::desktop_owner::process_admission(
            self.desktop_owned,
            &self.shutdown,
            &self.residency,
        )?;
        let agent = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get(agent_id)
            .cloned()
            .with_context(|| format!("agent was not found: {agent_id}"))?;
        if agent.status == "stopped" {
            bail!("agent is archived/stopped and must be explicitly resumed")
        }
        if let Some(worker) = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .get(&agent.worker_id)
            .filter(|worker| worker.alive.load(Ordering::SeqCst))
            .cloned()
        {
            return Ok(worker);
        }
        let previous_worker = {
            let mut workers = self.workers.lock().expect("workers mutex poisoned");
            if self.desktop_owned {
                workers.get(&agent.worker_id).cloned()
            } else {
                workers.remove(&agent.worker_id)
            }
        };
        let resident_count = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .len()
            .saturating_sub(usize::from(self.desktop_owned && previous_worker.is_some()));
        if resident_count >= configured_max_workers() {
            bail!("worker quota reached; no inactive worker could be resumed")
        }
        let descriptor_path = self.paths.worker_descriptor(&agent.worker_id);
        let mut descriptor = read_descriptor(&descriptor_path).with_context(|| {
            format!(
                "inactive agent has no resumable worker descriptor: {}",
                descriptor_path.display()
            )
        })?;
        if self.desktop_owned
            && let Some(worker) = &previous_worker
        {
            retain_worker_identity(&mut descriptor, &worker.descriptor)?;
        }
        let mut spawned_pid = None;
        let startup = (|| -> Result<_> {
            let connected_descriptor = if descriptor.status == "running"
                && process_alive(descriptor.pid)
                && descriptor.socket_path.exists()
            {
                descriptor.clone()
            } else {
                if self.desktop_owned {
                    let mut latest = read_descriptor(&descriptor_path)?;
                    retain_worker_identity(&mut latest, &descriptor)?;
                    descriptor = latest;
                }
                retire_orphaned_worker(&descriptor, self.desktop_owned, &descriptor_path)?;
                if self.desktop_owned {
                    self.workers
                        .lock()
                        .expect("workers mutex poisoned")
                        .remove(&agent.worker_id);
                }
                if agent.status != "inactive" {
                    let _ = self
                        .database
                        .mark_interrupted_agent_work_uncertain(agent_id);
                }
                self.database
                    .release_workspace_lease(&descriptor.workspace_id, &descriptor.root_agent_id)?;
                descriptor.generation = descriptor.generation.saturating_add(1);
                descriptor.pid = None;
                descriptor.child_pid = None;
                if self.desktop_owned {
                    descriptor.child_process_group = None;
                }
                descriptor.status = "starting".into();
                descriptor.socket_path = self.paths.worker_socket(&agent.worker_id);
                write_descriptor(&descriptor_path, &descriptor)?;
                spawned_pid = Some(spawn_worker_proxy(&descriptor_path)?);
                wait_for_worker(&descriptor_path, Duration::from_secs(20))?
            };
            let worker = connect_worker(connected_descriptor.clone(), self.database.clone())?;
            self.database
                .upsert_worker(&connected_descriptor, &descriptor_path)?;
            let summary = worker.call("session.summary", json!({}), WORKER_RPC_TIMEOUT)?;
            Ok((connected_descriptor, worker, summary))
        })();
        let (connected_descriptor, worker, summary) = match startup {
            Ok(started) => started,
            Err(error) => {
                if self.retain_failed_desktop_start(&descriptor_path, spawned_pid) {
                    return Err(error).context("desktop worker hydration UNKNOWN; identity retained and automatic restart blocked");
                }
                if spawned_pid.is_some() {
                    terminate_failed_worker_start(&descriptor_path, false, spawned_pid);
                }
                return Err(error).context("could not hydrate resident worker");
            }
        };
        self.workers
            .lock()
            .expect("workers mutex poisoned")
            .insert(agent.worker_id.clone(), Arc::clone(&worker));
        if let Some(current) = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get_mut(agent_id)
        {
            apply_session_summary(current, &summary);
            self.database.upsert_agent(current)?;
        }
        eprintln!(
            "{}",
            json!({
                "event": "worker_idle_hydrated",
                "worker_id": agent.worker_id,
                "agent_id": agent_id,
                "generation": connected_descriptor.generation,
            })
        );
        Ok(worker)
    }

    fn find_child(&self, agent_id: &str) -> Result<Option<(Arc<WorkerConnection>, Value)>> {
        let workers: Vec<_> = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .values()
            .cloned()
            .collect();
        for worker in workers {
            let Ok(status) = worker.call("subagent.status", json!({}), Duration::from_millis(750))
            else {
                continue;
            };
            if let Some(child) = status
                .get("jobs")
                .and_then(Value::as_array)
                .and_then(|jobs| {
                    jobs.iter().find(|job| {
                        job.get("id").and_then(Value::as_str) == Some(agent_id)
                            || job.get("agent_id").and_then(Value::as_str) == Some(agent_id)
                    })
                })
            {
                return Ok(Some((worker, child.clone())));
            }
        }
        Ok(None)
    }

    fn root_agent_id_for(&self, agent_id: &str) -> Result<String> {
        if let Some(root_id) = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get(agent_id)
            .map(|agent| agent.root_agent_id.clone())
        {
            return Ok(root_id);
        }
        self.find_child(agent_id)?
            .map(|(worker, _)| worker.descriptor.root_agent_id.clone())
            .with_context(|| format!("agent was not found: {agent_id}"))
    }

    fn route_agent_message(&self, command: &PublicCommand) -> Result<Value> {
        let from_agent_id = require_agent_id(command)?;
        let to_agent_id = command
            .params
            .get("to")
            .and_then(Value::as_str)
            .context("agent.message.send requires to")?;
        let message = command
            .params
            .get("message")
            .and_then(Value::as_str)
            .context("agent.message.send requires message")?;
        if message.is_empty() {
            bail!("agent message cannot be empty")
        }
        if message.len() > 64 * 1024 {
            bail!("agent message exceeds the 64 KiB limit")
        }
        let command_id = command
            .command_id
            .as_deref()
            .context("agent.message.send requires command_id")?;
        let message_id = format!(
            "msg-{}",
            Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{}:{command_id}", command.journal_client_id()).as_bytes(),
            )
        );
        self.database
            .record_message(&message_id, from_agent_id, to_agent_id, message)?;

        // Resolving the worker first also hydrates an inactive root tree when
        // the durable target is one of its retained children.
        let target_worker = self.worker_for_agent(to_agent_id)?;
        let target_root = self.root_agent_id_for(to_agent_id)?;
        let receive_params = json!({
            "from": from_agent_id,
            "message": message,
            "message_id": message_id,
        });
        let delivery = if target_root == to_agent_id {
            target_worker.call("agent.message.receive", receive_params, WORKER_RPC_TIMEOUT)?
        } else {
            target_worker.call(
                "subagent.invoke",
                json!({
                    "agent_id": to_agent_id,
                    "method": "agent.message.receive",
                    "params": receive_params,
                }),
                WORKER_RPC_TIMEOUT,
            )?
        };
        self.database.finish_message(&message_id, &delivery)?;

        let source_worker = self.worker_for_agent(from_agent_id)?;
        let source_root = self.root_agent_id_for(from_agent_id)?;
        let sent_params = json!({
            "to": to_agent_id,
            "message": message,
            "message_id": message_id,
        });
        let source_recorded = if source_root == from_agent_id {
            source_worker
                .call("agent.message.record_sent", sent_params, WORKER_RPC_TIMEOUT)
                .is_ok()
        } else {
            source_worker
                .call(
                    "subagent.invoke",
                    json!({
                        "agent_id": from_agent_id,
                        "method": "agent.message.record_sent",
                        "params": sent_params,
                    }),
                    WORKER_RPC_TIMEOUT,
                )
                .is_ok()
        };
        Ok(json!({
            "accepted": true,
            "message_id": message_id,
            "from": from_agent_id,
            "to": to_agent_id,
            "delivery": delivery,
            "source_recorded": source_recorded,
        }))
    }

    fn attach(
        &self,
        agent_id: &str,
        client_id: &str,
        attachment_id: &str,
        sender: SyncSender<Value>,
        cursor: Option<(u64, u64)>,
    ) -> Result<Value> {
        let worker = self.worker_for_agent(agent_id)?;
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        let controller = {
            let mut agents = self.agents.lock().expect("agents mutex poisoned");
            let agent = agents
                .get_mut(&root_agent_id)
                .context("root agent was not found")?;
            if agent.controller_client_id.is_none() {
                agent.controller_client_id = Some(client_id.to_owned());
                self.database.upsert_agent(agent)?;
            }
            agent.controller_client_id.as_deref() == Some(client_id)
        };
        let (replay_status, events) = cursor
            .map(|(generation, sequence)| worker.replay_after(agent_id, generation, sequence))
            .unwrap_or_else(|| ("unavailable".into(), Vec::new()));
        let (snapshot, snapshot_sequence) = {
            let _guard = worker
                .lifecycle
                .lock()
                .expect("worker lifecycle mutex poisoned");
            // Subscribe before snapshot construction: events arriving during
            // the read are replayed and deduplicated by snapshot revisions.
            let sequence =
                worker.attach_at_sequence(attachment_id.to_owned(), agent_id.to_owned(), sender);
            let snapshot = if root_agent_id == agent_id {
                worker.call_inner("session.snapshot", json!({}), WORKER_RPC_TIMEOUT)
            } else {
                worker.call_inner(
                    "subagent.invoke",
                    json!({"agent_id": agent_id, "method": "session.snapshot", "params": {}}),
                    WORKER_RPC_TIMEOUT,
                )
            };
            let snapshot = match snapshot {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    worker.detach(attachment_id);
                    let _ = self.release_control(agent_id, client_id);
                    return Err(error);
                }
            };
            (snapshot, sequence)
        };
        Ok(json!({
            "agent": self.public_agent(agent_id)?,
            "attachment_id": attachment_id,
            "controller": controller,
            "replay": {"status": replay_status, "events": events},
            "snapshot": decorate_snapshot(
                &worker.descriptor,
                worker.generation.load(Ordering::SeqCst),
                agent_id,
                snapshot_sequence,
                snapshot,
            )
        }))
    }

    fn assert_controller(&self, agent_id: &str, client_id: &str) -> Result<()> {
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        let agents = self.agents.lock().expect("agents mutex poisoned");
        let agent = agents
            .get(&root_agent_id)
            .with_context(|| format!("agent was not found: {agent_id}"))?;
        if agent.controller_client_id.as_deref() != Some(client_id) {
            bail!("client is an observer; take control before sending mutations")
        }
        Ok(())
    }

    fn take_control(&self, agent_id: &str, client_id: &str) -> Result<Value> {
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        let mut agents = self.agents.lock().expect("agents mutex poisoned");
        let agent = agents
            .get_mut(&root_agent_id)
            .with_context(|| format!("agent was not found: {agent_id}"))?;
        let previous = agent.controller_client_id.replace(client_id.to_owned());
        self.database.upsert_agent(agent)?;
        Ok(json!({"controller": true, "previous_client_id": previous}))
    }

    fn release_control(&self, agent_id: &str, client_id: &str) -> Result<()> {
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        let mut agents = self.agents.lock().expect("agents mutex poisoned");
        let Some(agent) = agents.get_mut(&root_agent_id) else {
            return Ok(());
        };
        if agent.controller_client_id.as_deref() == Some(client_id) {
            agent.controller_client_id = None;
            self.database.upsert_agent(agent)?;
        }
        Ok(())
    }

    fn inspect_idle_worker(
        &self,
        worker: &WorkerConnection,
        threshold: Duration,
        lifecycle_fenced: bool,
    ) -> Result<IdleInspection> {
        let invoke = |method: &str, params: Value, timeout: Duration| {
            if lifecycle_fenced {
                worker.call_inner(method, params, timeout)
            } else {
                worker.call(method, params, timeout)
            }
        };
        let now = now_ms();
        let threshold_ms = threshold.as_millis();
        let mut pin_reasons = Vec::new();
        if !worker
            .pending
            .lock()
            .expect("worker pending mutex poisoned")
            .is_empty()
        {
            pin_reasons.push("worker-call-in-flight".into());
        }
        let mut agent_ids = HashSet::from([worker.descriptor.root_agent_id.clone()]);
        let mut last_activity_at_ms = None;
        let root_summary = invoke("session.summary", json!({}), Duration::from_millis(1_500))?;
        let lifecycle = root_summary
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or("draft")
            .to_owned();
        inspect_session_idle(
            &root_summary,
            &worker.descriptor.root_agent_id,
            now,
            threshold_ms,
            &mut last_activity_at_ms,
            &mut pin_reasons,
        );

        let child_status = invoke("subagent.status", json!({}), Duration::from_millis(1_500))?;
        for child in child_status
            .get("jobs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(child_id) = child
                .get("agent_id")
                .or_else(|| child.get("id"))
                .and_then(Value::as_str)
            else {
                pin_reasons.push("child-without-identity".into());
                continue;
            };
            let status = child
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if matches!(status, "stopped" | "deleted" | "failed" | "inactive") {
                continue;
            }
            agent_ids.insert(child_id.to_owned());
            if status == "running" {
                pin_reasons.push(format!("busy:{child_id}"));
            }
            match invoke(
                "subagent.invoke",
                json!({
                    "agent_id": child_id,
                    "method": "session.summary",
                    "params": {},
                }),
                Duration::from_millis(1_500),
            ) {
                Ok(summary) => inspect_session_idle(
                    &summary,
                    child_id,
                    now,
                    threshold_ms,
                    &mut last_activity_at_ms,
                    &mut pin_reasons,
                ),
                Err(_) => pin_reasons.push(format!("summary-unavailable:{child_id}")),
            }
        }

        let attachment_count = worker
            .attachments
            .lock()
            .expect("worker attachments mutex poisoned")
            .len();
        if attachment_count > 0 {
            pin_reasons.push(format!("attached:{attachment_count}"));
        }
        if !worker.alive.load(Ordering::SeqCst) {
            pin_reasons.push("worker-unavailable".into());
        }
        let worker_status = worker
            .status
            .lock()
            .expect("worker status mutex poisoned")
            .clone();
        if !matches!(worker_status.as_str(), "idle" | "running") {
            pin_reasons.push(format!("worker:{worker_status}"));
        }
        if self.database.has_running_task(&agent_ids)? {
            pin_reasons.push("running-task".into());
        }
        pin_reasons.extend(self.database.idle_schedule_pins(&agent_ids)?);
        pin_reasons.sort();
        pin_reasons.dedup();
        Ok(IdleInspection {
            eligible: pin_reasons.is_empty(),
            pin_reasons,
            last_activity_at_ms,
            lifecycle,
            agent_ids,
        })
    }

    fn passivate_idle_children(
        &self,
        worker: &WorkerConnection,
        threshold: Duration,
    ) -> Vec<Value> {
        let Ok(status) = worker.call("subagent.status", json!({}), Duration::from_millis(1_500))
        else {
            return Vec::new();
        };
        let attached: HashSet<String> = worker
            .attachments
            .lock()
            .expect("worker attachments mutex poisoned")
            .values()
            .map(|(agent_id, _)| agent_id.clone())
            .collect();
        let mut candidates = Vec::new();
        for child in status
            .get("jobs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(child_id) = child
                .get("agent_id")
                .or_else(|| child.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if attached.contains(child_id)
                || child.get("resident").and_then(Value::as_bool) != Some(true)
                || child.get("status").and_then(Value::as_str) == Some("running")
            {
                continue;
            }
            let Ok(summary) = worker.call(
                "subagent.invoke",
                json!({
                    "agent_id": child_id,
                    "method": "session.summary",
                    "params": {},
                }),
                Duration::from_millis(1_500),
            ) else {
                continue;
            };
            let mut newest = None;
            let mut pins = Vec::new();
            inspect_session_idle(
                &summary,
                child_id,
                now_ms(),
                threshold.as_millis(),
                &mut newest,
                &mut pins,
            );
            let ids = HashSet::from([child_id.to_owned()]);
            if self.database.has_running_task(&ids).unwrap_or(true) {
                pins.push("running-task".into());
            }
            pins.extend(
                self.database
                    .idle_schedule_pins(&ids)
                    .unwrap_or_else(|_| vec!["schedule-state-unavailable".into()]),
            );
            if pins.is_empty()
                && let Some(last_activity) = newest
            {
                candidates.push((last_activity, child_id.to_owned()));
            }
        }
        candidates.sort_by_key(|(last_activity, _)| *last_activity);
        let mut outcomes = Vec::new();
        for (_, child_id) in candidates.into_iter().take(2) {
            let _fence = worker
                .lifecycle
                .lock()
                .expect("worker lifecycle mutex poisoned");
            if !worker
                .pending
                .lock()
                .expect("worker pending mutex poisoned")
                .is_empty()
            {
                continue;
            }
            if worker
                .attachments
                .lock()
                .expect("worker attachments mutex poisoned")
                .values()
                .any(|(attached_id, _)| attached_id == &child_id)
            {
                continue;
            }
            let Ok(summary) = worker.call_inner(
                "subagent.invoke",
                json!({
                    "agent_id": child_id,
                    "method": "session.summary",
                    "params": {},
                }),
                Duration::from_millis(1_500),
            ) else {
                continue;
            };
            let mut newest = None;
            let mut pins = Vec::new();
            inspect_session_idle(
                &summary,
                &child_id,
                now_ms(),
                threshold.as_millis(),
                &mut newest,
                &mut pins,
            );
            let ids = HashSet::from([child_id.clone()]);
            if self.database.has_running_task(&ids).unwrap_or(true) {
                pins.push("running-task".into());
            }
            pins.extend(
                self.database
                    .idle_schedule_pins(&ids)
                    .unwrap_or_else(|_| vec!["schedule-state-unavailable".into()]),
            );
            if !pins.is_empty() {
                continue;
            }
            let Ok(result) = worker.call_inner(
                "subagent.passivate",
                json!({"agent_id": child_id}),
                Duration::from_secs(5),
            ) else {
                continue;
            };
            if result.get("passivated").and_then(Value::as_bool) == Some(true) {
                let outcome = json!({
                    "agent_id": child_id,
                    "last_activity_at_ms": newest,
                    "passivated": true,
                });
                eprintln!(
                    "{}",
                    json!({
                        "event": "child_passivation_completed",
                        "worker_id": worker.descriptor.worker_id,
                        "agent_id": child_id,
                        "last_activity_at_ms": newest,
                    })
                );
                outcomes.push(outcome);
            }
        }
        outcomes
    }

    fn sweep_idle_workers(&self) -> Result<Vec<Value>> {
        let Some(threshold) = configured_idle_eviction() else {
            return Ok(Vec::new());
        };
        self.sweep_idle_workers_with_threshold(threshold, false)
    }

    fn sweep_idle_workers_with_threshold(
        &self,
        threshold: Duration,
        capacity: bool,
    ) -> Result<Vec<Value>> {
        if self
            .idle_sweep_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(Vec::new());
        }
        let result = (|| -> Result<Vec<Value>> {
            self.last_idle_sweep_at_ms.store(
                u64::try_from(now_ms()).unwrap_or(u64::MAX),
                Ordering::SeqCst,
            );
            let workers: Vec<_> = self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .values()
                .cloned()
                .collect();
            let mut outcomes = Vec::new();
            for worker in workers {
                let initial = match worker.lifecycle.try_lock() {
                    Ok(_fence) => match self.inspect_idle_worker(&worker, threshold, true) {
                        Ok(inspection) => inspection,
                        Err(error) => {
                            outcomes.push(json!({
                                "worker_id": worker.descriptor.worker_id,
                                "evicted": false,
                                "pin_reasons": [format!("inspection-error:{error}")],
                            }));
                            continue;
                        }
                    },
                    Err(_) => {
                        outcomes.push(json!({
                            "worker_id": worker.descriptor.worker_id,
                            "evicted": false,
                            "pin_reasons": ["worker-call-in-flight"],
                        }));
                        continue;
                    }
                };
                if !initial.eligible {
                    let mut outcome = idle_inspection_value(&worker, &initial, threshold, false);
                    let passivated = if capacity {
                        Vec::new()
                    } else {
                        self.passivate_idle_children(&worker, threshold)
                    };
                    if let Some(object) = outcome.as_object_mut() {
                        object.insert("child_passivations".into(), Value::Array(passivated));
                    }
                    outcomes.push(outcome);
                    continue;
                }
                let _worker_fence = worker
                    .lifecycle
                    .lock()
                    .expect("worker lifecycle mutex poisoned");
                let refreshed = match self.inspect_idle_worker(&worker, threshold, true) {
                    Ok(inspection) => inspection,
                    Err(error) => {
                        outcomes.push(json!({
                            "worker_id": worker.descriptor.worker_id,
                            "evicted": false,
                            "pin_reasons": [format!("refresh-error:{error}")],
                        }));
                        continue;
                    }
                };
                if !refreshed.eligible {
                    outcomes.push(idle_inspection_value(&worker, &refreshed, threshold, false));
                    continue;
                }
                if let Err(error) = worker.call_inner(
                    "shutdown",
                    json!({"reason": "idle-eviction"}),
                    Duration::from_secs(3),
                ) {
                    outcomes.push(json!({
                        "worker_id": worker.descriptor.worker_id,
                        "evicted": false,
                        "pin_reasons": [format!("graceful-stop-failed:{error}")],
                    }));
                    continue;
                }
                if !wait_for_worker_stop(
                    &self.paths.worker_descriptor(&worker.descriptor.worker_id),
                    worker.descriptor.pid,
                    Duration::from_secs(5),
                ) {
                    outcomes.push(json!({
                        "worker_id": worker.descriptor.worker_id,
                        "evicted": false,
                        "pin_reasons": ["graceful-stop-timeout"],
                    }));
                    continue;
                }
                if self.desktop_owned
                    && let Err(error) = retire_orphaned_worker(
                        &worker.descriptor,
                        true,
                        &self.paths.worker_descriptor(&worker.descriptor.worker_id),
                    )
                {
                    outcomes.push(json!({"worker_id":worker.descriptor.worker_id,
                        "evicted":false,"pin_reasons":[format!("cleanup-unknown:{error}")]}));
                    continue;
                }
                let _residency = self
                    .residency
                    .lock()
                    .expect("runtime residency mutex poisoned");
                self.workers
                    .lock()
                    .expect("workers mutex poisoned")
                    .remove(&worker.descriptor.worker_id);
                let _ = self.database.release_workspace_lease(
                    &worker.descriptor.workspace_id,
                    &worker.descriptor.root_agent_id,
                );
                let _ = self
                    .database
                    .set_worker_status(&worker.descriptor.worker_id, "inactive");
                if let Some(agent) = self
                    .agents
                    .lock()
                    .expect("agents mutex poisoned")
                    .get_mut(&worker.descriptor.root_agent_id)
                {
                    agent.status = "inactive".into();
                    agent.lifecycle = refreshed.lifecycle.clone();
                    agent.last_activity_at_ms = refreshed.last_activity_at_ms;
                    agent.inactive_reason = Some("idle-eviction".into());
                    agent.controller_client_id = None;
                    self.database.upsert_agent(agent)?;
                }
                let outcome = idle_inspection_value(&worker, &refreshed, threshold, true);
                eprintln!(
                    "{}",
                    json!({
                        "event": "worker_idle_eviction_completed",
                        "worker_id": worker.descriptor.worker_id,
                        "agent_id": worker.descriptor.root_agent_id,
                        "last_activity_at_ms": refreshed.last_activity_at_ms,
                        "session_count": refreshed.agent_ids.len(),
                    })
                );
                outcomes.push(outcome);
                if capacity {
                    break;
                }
            }
            Ok(outcomes)
        })();
        self.idle_sweep_running.store(false, Ordering::SeqCst);
        result
    }

    fn recover_session_archives(&self) {
        let jobs = (|| -> Result<Vec<(String, String)>> {
            let connection = self.database.connection()?;
            let mut query = connection.prepare(
                "SELECT source_path,archive_path FROM session_archives WHERE status='pending'",
            )?;
            Ok(query
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })();
        if let Ok(jobs) = jobs {
            for (source, target) in jobs {
                if let Err(error) =
                    self.archive_session(Path::new(&source), Path::new(&target), None)
                {
                    eprintln!("session archive recovery deferred: {error:#}");
                }
            }
        }
    }

    fn archive_session(
        &self,
        source: &Path,
        target: &Path,
        client_id: Option<&str>,
    ) -> Result<Value> {
        reject_archive_symlink(source)?;
        reject_archive_symlink(target)?;
        let source = normalize_session_path(source)?;
        let target = normalize_session_path(target)?;
        if source == target
            || source.extension().and_then(|value| value.to_str()) != Some("jsonl")
            || target.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            bail!("archive requires distinct JSONL source and destination paths")
        }
        let _residency = self
            .residency
            .lock()
            .expect("runtime residency mutex poisoned");
        let source_file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&source)
        {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .context("could not open original session without following links");
            }
        };
        let connection = self.database.connection()?;
        let previous: Option<(String, Option<String>, String)> = connection
            .query_row(
                "SELECT archive_path,agent_id,status FROM session_archives WHERE source_path=?1",
                params![source.to_string_lossy()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((destination, agent_id, status)) = &previous {
            if destination != target.to_string_lossy().as_ref() {
                bail!("session already has a different archive destination")
            }
            if status == "completed" && target.is_file() {
                return Ok(json!({"archived":true,"session_path":target,"agent_id":agent_id}));
            }
        } else if !source.is_file() || target.exists() {
            bail!("session source is missing or archive destination already exists")
        }
        let mut agent = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .find(|agent| {
                agent.session_path == source
                    || previous.as_ref().and_then(|(_, id, _)| id.as_deref())
                        == Some(agent.agent_id.as_str())
            })
            .cloned();
        if let Some(client_id) = client_id
            && agent
                .as_ref()
                .and_then(|agent| agent.controller_client_id.as_deref())
                .is_some_and(|controller| controller != client_id)
        {
            bail!("client is an observer; take control before archiving this session")
        }
        let reserved = connection.execute(
            "INSERT OR IGNORE INTO session_archives(source_path,archive_path,agent_id,status)
             VALUES (?1,?2,?3,'pending')",
            params![
                source.to_string_lossy(),
                target.to_string_lossy(),
                agent.as_ref().map(|a| &a.agent_id)
            ],
        )?;
        if reserved == 0 && previous.is_none() {
            bail!("archive destination is already reserved for another session")
        }
        if let Some(current) = agent.as_mut() {
            // Fence new calls before stopping the writer. If moving fails, the
            // transcript remains at its original path and the operation is retryable.
            current.status = "stopped".into();
            current.lifecycle = "archived".into();
            current.controller_client_id = None;
            current.inactive_reason = Some("explicit-archive".into());
            self.database.upsert_agent(current)?;
            self.agents
                .lock()
                .expect("agents mutex poisoned")
                .insert(current.agent_id.clone(), current.clone());
            let descriptor_path = self.paths.worker_descriptor(&current.worker_id);
            let descriptor = read_descriptor(&descriptor_path);
            if self.desktop_owned && descriptor.is_err() {
                bail!(
                    "desktop archive cleanup UNKNOWN; worker descriptor retained for reconciliation"
                );
            }
            if let Ok(mut descriptor) = descriptor {
                let worker = self
                    .workers
                    .lock()
                    .expect("workers mutex poisoned")
                    .get(&current.worker_id)
                    .cloned()
                    .filter(|worker| worker.alive.load(Ordering::SeqCst))
                    .or_else(|| {
                        if descriptor.status == "running" && process_alive(descriptor.pid) {
                            connect_worker(descriptor.clone(), self.database.clone()).ok()
                        } else {
                            None
                        }
                    });
                if self.desktop_owned
                    && let Some(worker) = &worker
                {
                    retain_worker_identity(&mut descriptor, &worker.descriptor)?;
                }
                if let Some(worker) = worker {
                    // Archiving must also interrupt a long-running RPC. New
                    // commands are already fenced by the stopped agent record.
                    let _fence = worker.lifecycle.try_lock().ok();
                    let _ = worker.call_inner(
                        "shutdown",
                        json!({"reason":"archive"}),
                        Duration::from_secs(3),
                    );
                    worker.alive.store(false, Ordering::SeqCst);
                }
                if !wait_for_worker_stop(&descriptor_path, descriptor.pid, Duration::from_secs(5)) {
                    if self.desktop_owned {
                        check_desktop_process_observations(&descriptor)?;
                    }
                    terminate_worker_groups(&descriptor);
                }
                if self.desktop_owned {
                    let mut latest = read_descriptor(&descriptor_path)?;
                    retain_worker_identity(&mut latest, &descriptor)?;
                    descriptor = latest;
                }
                retire_orphaned_worker(&descriptor, self.desktop_owned, &descriptor_path)?;
                self.database
                    .release_workspace_lease(&descriptor.workspace_id, &descriptor.root_agent_id)?;
            }
            self.workers
                .lock()
                .expect("workers mutex poisoned")
                .remove(&current.worker_id);
            self.database
                .mark_interrupted_agent_work_uncertain(&current.agent_id)?;
            connection.execute("UPDATE schedules SET status='cancelled',claim=NULL,next_at_ms=NULL,revision=revision+1 WHERE agent_id=?1",
                params![current.agent_id])?;
            connection.execute("UPDATE goals SET status='cancelled',updated_at_ms=?2 WHERE agent_id=?1 AND status IN ('active','uncertain','blocked')",
                params![current.agent_id, now_ms_i64()])?;
        }
        let lease_path = PathBuf::from(format!("{}.writer.lock", source.display()));
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&lease_path)?;
        lease
            .try_lock_exclusive()
            .context("session writer is still active; archive deferred")?;
        let parent = target
            .parent()
            .context("archive destination has no parent")?;
        fs::create_dir_all(parent)?;
        set_owner_only_dir(parent)?;
        if source.exists() {
            reject_archive_symlink(&source)?;
            if target.exists() {
                reject_archive_symlink(&target)?;
                use std::os::unix::fs::MetadataExt;
                let original = fs::metadata(&source)?;
                let archived = fs::metadata(&target)?;
                if (original.dev(), original.ino()) != (archived.dev(), archived.ino()) {
                    bail!("archive destination contains a different file")
                }
            } else {
                // Linking fails if target exists, so concurrent writers cannot
                // cause an overwrite. The original survives all pre-commit errors.
                fs::hard_link(&source, &target)
                    .context("could not preserve transcript in archive")?;
            }
        } else if !target.is_file() {
            bail!("both session and archive files are missing")
        }
        if let Some(file) = &source_file {
            use std::os::unix::fs::MetadataExt;
            let opened = file.metadata()?;
            let archived = fs::symlink_metadata(&target)?;
            if !archived.is_file()
                || (opened.dev(), opened.ino()) != (archived.dev(), archived.ino())
            {
                bail!("session changed during archive; original history was not removed")
            }
        }
        if let Some(current) = agent.as_mut() {
            let descriptor_path = self.paths.worker_descriptor(&current.worker_id);
            if let Ok(mut descriptor) = read_descriptor(&descriptor_path) {
                descriptor.session_path = target.clone();
                descriptor.status = "stopped".into();
                descriptor.pid = None;
                descriptor.child_pid = None;
                write_descriptor(&descriptor_path, &descriptor)?;
                self.database.upsert_worker(&descriptor, &descriptor_path)?;
            }
            current.session_path = target.clone();
            self.database.upsert_agent(current)?;
            self.agents
                .lock()
                .expect("agents mutex poisoned")
                .insert(current.agent_id.clone(), current.clone());
        }
        if source.exists() {
            use std::os::unix::fs::MetadataExt;
            let original = fs::symlink_metadata(&source)?;
            let archived = fs::symlink_metadata(&target)?;
            if !original.is_file()
                || (original.dev(), original.ino()) != (archived.dev(), archived.ino())
            {
                bail!("session path changed during archive; original path was not removed")
            }
            fs::remove_file(&source)?;
        }
        connection.execute(
            "UPDATE session_archives SET status='completed' WHERE source_path=?1",
            params![source.to_string_lossy()],
        )?;
        Ok(json!({"archived":true,"session_path":target,"agent_id":agent.map(|a| a.agent_id)}))
    }

    fn stop_agent(&self, agent_id: &str) -> Result<Value> {
        self.stop_agent_inner(agent_id, false)
    }

    fn stop_agent_inner(&self, agent_id: &str, preserve_session: bool) -> Result<Value> {
        let root = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .contains_key(agent_id);
        if !root {
            let worker = self.worker_for_agent(agent_id)?;
            return worker.call(
                "subagent.stop",
                json!({"agent_id": agent_id}),
                Duration::from_secs(3),
            );
        }
        let (agent, worker, resume_lifecycle) = {
            let _residency = self
                .residency
                .lock()
                .expect("runtime residency mutex poisoned");
            // Publish the stop while holding the hydration/adoption gate. A
            // missing or disconnected worker must never be started to stop it.
            let (agent, resume_lifecycle) = {
                let mut agents = self.agents.lock().expect("agents mutex poisoned");
                let agent = agents.get_mut(agent_id).context("agent was not found")?;
                let resume_lifecycle = (preserve_session && agent.status != "stopped")
                    .then(|| agent.lifecycle.clone());
                agent.status = "stopped".into();
                agent.lifecycle = "archived".into();
                agent.inactive_reason = Some(if resume_lifecycle.is_some() {
                    "desktop-shutdown-pending"
                } else {
                    "explicit-stop"
                }.into());
                self.database.upsert_agent(agent)?;
                (agent.clone(), resume_lifecycle)
            };
            let worker = self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .get(&agent.worker_id)
                .cloned();
            (agent, worker, resume_lifecycle)
        };
        // No residency/registry lock is held while waiting for an admitted RPC
        // or retiring its process tree. Hydration now observes the stopped root.
        let _fence = worker.as_ref().map(|worker| {
            worker
                .lifecycle
                .lock()
                .expect("worker lifecycle mutex poisoned")
        });
        let descriptor_path = self.paths.worker_descriptor(&agent.worker_id);
        let descriptor = match read_descriptor(&descriptor_path)
            .or_else(|error| worker.as_ref().map(|w| w.descriptor.clone()).ok_or(error))
        {
            Ok(descriptor) => Some(descriptor),
            Err(error) => {
                // A passivated/already stopped worker can have its descriptor
                // removed. Only durable proof of inactivity and no lease makes
                // that harmless; an unknown writer must retain its lease.
                let safely_inactive = worker.is_none()
                    && error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                        error.kind() == std::io::ErrorKind::NotFound
                    })
                    && self.database.connection()?.query_row(
                        "SELECT EXISTS(SELECT 1 FROM workers WHERE worker_id=?1 AND status IN ('inactive','stopped')) AND NOT EXISTS(SELECT 1 FROM leases WHERE owner=?2)",
                        params![agent.worker_id, agent.root_agent_id],
                        |row| row.get::<_, bool>(0),
                    )?;
                if !safely_inactive {
                    return Err(error).context("cannot verify stopped worker process identity");
                }
                None
            }
        };
        let result = worker
            .as_ref()
            .filter(|worker| worker.alive.load(Ordering::SeqCst))
            .map(|worker| {
                worker
                    .call_inner("shutdown", json!({}), Duration::from_secs(3))
                    .unwrap_or_else(|_| json!({"shutting-down": true}))
            })
            .unwrap_or_else(|| json!({"stopped": true, "resident": false}));
        if let Some(worker) = &worker {
            worker.alive.store(false, Ordering::SeqCst);
        }
        if let Some(mut descriptor) = descriptor {
            if self.desktop_owned
                && let Some(worker) = &worker
            {
                retain_worker_identity(&mut descriptor, &worker.descriptor)?;
            }
            if !wait_for_worker_stop(&descriptor_path, descriptor.pid, Duration::from_secs(5)) {
                if self.desktop_owned {
                    check_desktop_process_observations(&descriptor)?;
                    terminate_worker_groups(&descriptor);
                } else {
                    terminate_failed_worker_start(&descriptor_path, false, descriptor.pid);
                }
            }
            if self.desktop_owned {
                let mut latest = read_descriptor(&descriptor_path)?;
                retain_worker_identity(&mut latest, &descriptor)?;
                descriptor = latest;
            }
            retire_orphaned_worker(&descriptor, self.desktop_owned, &descriptor_path)?;
            if self.desktop_owned {
                let mut stopped = descriptor;
                stopped.pid = None;
                stopped.child_pid = None;
                // All recorded groups/helpers were proven absent above. Do not
                // carry their stale OS identities into a later desktop launch.
                stopped.child_process_group = None;
                stopped.owned_helpers.clear();
                stopped.status = "stopped".into();
                write_descriptor(&descriptor_path, &stopped)?;
            }
        }
        self.database
            .release_workspace_lease(&agent.workspace_id, &agent.root_agent_id)?;
        self.workers
            .lock()
            .expect("workers mutex poisoned")
            .remove(&agent.worker_id);
        if let Some(agent) = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get_mut(agent_id)
        {
            agent.controller_client_id = None;
            if let Some(lifecycle) = resume_lifecycle
                && agent.inactive_reason.as_deref() == Some("desktop-shutdown-pending")
                && !self.desktop_startup_unknown.load(Ordering::SeqCst)
            {
                // Closing the desktop stops processes, not the saved session.
                // Publish resumability only after confirmed cleanup and durable
                // reconciliation; a concurrent explicit stop takes precedence.
                self.database.mark_interrupted_agent_work_uncertain(agent_id)?;
                let mut resumed = agent.clone();
                resumed.status = "inactive".into();
                resumed.lifecycle = lifecycle;
                resumed.inactive_reason = Some("desktop-shutdown".into());
                self.database.set_worker_status(&agent.worker_id, "inactive")?;
                self.database.upsert_agent(&resumed)?;
                *agent = resumed;
                return Ok(result);
            }
            self.database.upsert_agent(agent)?;
        }
        let _ = self.database.set_worker_status(&agent.worker_id, "stopped");
        Ok(result)
    }

    fn stop_all_workers_checked(&self) -> Vec<String> {
        let agent_ids: Vec<_> = {
            // Do not hold residency across stop_agent (it takes that lock).
            // Once shutdown=true, later desktop starters fail under this same
            // gate; earlier worker/helper starts finish before this snapshot.
            let _drained =
                crate::desktop_owner::drain_processes(self.desktop_owned, &self.residency);
            self.agents
                .lock()
                .expect("agents mutex poisoned")
                .keys()
                .cloned()
                .collect()
        };
        let mut errors = Vec::new();
        for agent_id in agent_ids {
            if self.stop_agent_inner(&agent_id, self.desktop_owned
                && !self.desktop_startup_unknown.load(Ordering::SeqCst)).is_err() {
                errors.push(format!("worker cleanup failed for agent {agent_id}"));
            }
        }
        if self.desktop_owned {
            let remaining = self.workers.lock().expect("workers mutex poisoned").len();
            if remaining != 0 {
                errors.push(format!(
                    "{remaining} worker registrations remain after cleanup"
                ));
            }
            if self.desktop_startup_unknown.load(Ordering::SeqCst) {
                errors.push("failed worker startup cleanup is UNKNOWN; retained identity requires reconciliation".into());
            }
        }
        errors
    }
}

fn finish_client_command(
    runtime: &Arc<Runtime>,
    command: &PublicCommand,
    writer: &Arc<Mutex<BufWriter<UnixStream>>>,
    result: Result<Value>,
) -> Result<()> {
    match result {
        Ok(result) => {
            if let Some(command_id) = command.command_id.as_deref()
                && wire::mutation(&command.method)
            {
                runtime.database.finish_command(
                    command.journal_client_id(),
                    command_id,
                    "completed",
                    &result,
                )?;
            }
            write_command_response(writer, &command.request_id, result)?;
        }
        Err(error) => {
            let uncertain =
                wire::mutation(&command.method) && uncertain_worker_failure(&error.to_string());
            let public_error = error.downcast_ref::<PublicApiError>();
            let error_data = if uncertain {
                json!({"status": "uncertain"})
            } else if let Some(public) = public_error {
                json!({"type": public.code})
            } else {
                Value::Null
            };
            let failure = json!({"message": error.to_string(), "data": error_data});
            if let Some(command_id) = command.command_id.as_deref()
                && wire::mutation(&command.method)
                && !uncertain
            {
                runtime.database.finish_command(
                    command.journal_client_id(),
                    command_id,
                    "failed",
                    &failure,
                )?;
            }
            write_value(
                writer,
                &wire::error_response(&command.request_id, error.to_string(), error_data),
            )?;
        }
    }
    Ok(())
}

// These operations must remain reachable while the ordered command lane waits
// for a long RPC. They never modify the connection's attachment map.
fn control_command(method: &str) -> bool {
    matches!(
        method,
        "command.status"
            | "interaction.resolve"
            | "planning.cancel"
            | "planning.exit"
            | "planning.pause"
            | "repl.interrupt"
            | "turn.abort"
            | "run.abort"
            | "agent.stop"
            | "subagent.stop"
            | "daemon.shutdown"
    )
}

fn handle_client(runtime: Arc<Runtime>, stream: UnixStream) -> Result<()> {
    let attachment_id = format!("attachment-{}", Uuid::new_v4());
    let writer = Arc::new(Mutex::new(BufWriter::new(stream.try_clone()?)));
    let (event_tx, event_rx) = mpsc::sync_channel::<Value>(ATTACHMENT_QUEUE_LIMIT);
    let event_writer = Arc::clone(&writer);
    let event_pump = thread::spawn(move || {
        for event in event_rx {
            if write_value(&event_writer, &event).is_err() {
                break;
            }
        }
    });
    let (command_tx, command_rx) = mpsc::sync_channel::<PublicCommand>(32);
    let command_runtime = Arc::clone(&runtime);
    let command_writer = Arc::clone(&writer);
    let command_events = event_tx.clone();
    let command_attachment = attachment_id.clone();
    let command_pump = thread::spawn(move || {
        let mut attached_workers = HashMap::new();
        let mut client_id = None;
        for command in command_rx {
            client_id = Some(command.client_id.clone());
            let result = dispatch(
                &command_runtime,
                &command,
                &command_attachment,
                command_events.clone(),
                &mut attached_workers,
            );
            if finish_client_command(&command_runtime, &command, &command_writer, result).is_err() {
                break;
            }
        }
        for (agent_id, worker) in &attached_workers {
            worker.detach(&command_attachment);
            if let Some(client_id) = client_id.as_deref() {
                let _ = command_runtime.release_control(agent_id, client_id);
            }
        }
    });
    let mut stable_client_id: Option<String> = None;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let command = match serde_json::from_str::<PublicCommand>(&line) {
            Ok(command) => command,
            Err(error) => {
                write_value(
                    &writer,
                    &wire::error_response("", format!("invalid command: {error}"), Value::Null),
                )?;
                continue;
            }
        };
        if command.version != PROTOCOL_VERSION || command.kind != "command" {
            write_value(
                &writer,
                &wire::error_response(
                    &command.request_id,
                    "unsupported protocol envelope",
                    json!({"supported_version": PROTOCOL_VERSION}),
                ),
            )?;
            continue;
        }
        if command.client_id.is_empty() {
            write_value(
                &writer,
                &wire::error_response(&command.request_id, "client_id is required", Value::Null),
            )?;
            continue;
        }
        if stable_client_id
            .as_ref()
            .is_some_and(|value| value != &command.client_id)
        {
            write_value(
                &writer,
                &wire::error_response(
                    &command.request_id,
                    "client_id cannot change within one connection",
                    Value::Null,
                ),
            )?;
            continue;
        }
        stable_client_id.get_or_insert_with(|| command.client_id.clone());

        let journal = if wire::mutation(&command.method) {
            match runtime.database.begin_command(&command) {
                Ok(entry) => Some(entry),
                Err(error) => {
                    write_value(
                        &writer,
                        &wire::error_response(&command.request_id, error.to_string(), Value::Null),
                    )?;
                    continue;
                }
            }
        } else {
            None
        };
        match journal {
            Some(JournalEntry::Completed(result)) => {
                write_command_response(&writer, &command.request_id, result)?;
                if command.method == "daemon.shutdown" {
                    schedule_shutdown(&runtime);
                    break;
                }
                continue;
            }
            Some(JournalEntry::Failed(error)) => {
                write_value(
                    &writer,
                    &wire::error_response(
                        &command.request_id,
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("previous command failed"),
                        error.get("data").cloned().unwrap_or(Value::Null),
                    ),
                )?;
                continue;
            }
            Some(JournalEntry::Pending) => {
                write_value(
                    &writer,
                    &wire::error_response(
                        &command.request_id,
                        "command outcome is uncertain; it will not be replayed",
                        json!({"status": "uncertain"}),
                    ),
                )?;
                continue;
            }
            Some(JournalEntry::New) | None => {}
        }

        if control_command(&command.method) {
            let result = dispatch(
                &runtime,
                &command,
                &attachment_id,
                event_tx.clone(),
                &mut HashMap::new(),
            );
            finish_client_command(&runtime, &command, &writer, result)?;
            if command.method == "daemon.shutdown" {
                schedule_shutdown(&runtime);
                break;
            }
        } else if let Err(error) = command_tx.try_send(command) {
            let command = match error {
                TrySendError::Full(command) | TrySendError::Disconnected(command) => command,
            };
            finish_client_command(
                &runtime,
                &command,
                &writer,
                Err(api_error(
                    "client_busy",
                    "client command queue is full or closed; retry after pending commands finish",
                )),
            )?;
        }
    }
    drop(command_tx);
    let _ = command_pump.join();

    drop(event_tx);
    let _ = event_pump.join();
    Ok(())
}

fn uncertain_worker_failure(message: &str) -> bool {
    message.contains("outcome is uncertain")
        || message.contains("worker RPC") && message.contains("did not complete")
        || message.contains("worker is unavailable")
        || message.contains("worker is recovering")
}

fn dispatch(
    runtime: &Arc<Runtime>,
    command: &PublicCommand,
    attachment_id: &str,
    event_tx: SyncSender<Value>,
    attached_workers: &mut HashMap<String, Arc<WorkerConnection>>,
) -> Result<Value> {
    match command.method.as_str() {
        "command.status" => runtime.database.command_status(
            command.journal_client_id(),
            command
                .params
                .get("command_id")
                .and_then(Value::as_str)
                .context("command.status requires command_id")?,
        ),
        "daemon.hello" => Ok(json!({
            "protocol_version": PROTOCOL_VERSION,
            "daemon_version": env!("CARGO_PKG_VERSION"),
            "default_config_path": runtime.config_path,
            "capabilities": [
                "agent.attach", "cursor.generation", "command.idempotency",
                "controller.lease", "worker.adoption", "repl.v1",
                "repl.backend-selection.v1", "schedule.v1", "goal.v1",
                "durable.messaging.v1", "session.lifecycle.v1",
                "worker.idle-eviction.v1", "database.backup.v1",
                "agent.preset-selection.v1", "preset.discovery.v1", "command.status.v1"
            ]
        })),
        "daemon.status" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "socket": runtime.paths.public_socket,
            "database": runtime.paths.database,
            "agents": runtime.list_agents(),
            "worker_count": runtime.workers.lock().expect("workers mutex poisoned").len(),
            "worker_quota": configured_max_workers(),
            "idle_eviction": idle_eviction_status(runtime),
            "schedules": runtime.database.list_schedules(None)?,
            "goals": runtime.database.list_goals(None)?,
        })),
        "daemon.doctor" => Ok(doctor(
            runtime,
            command
                .params
                .get("fix")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )),
        "daemon.backup" => {
            let path = runtime.database.backup("manual")?;
            Ok(json!({"created": true, "path": path}))
        }
        "daemon.update" => {
            let purged_expired_leases = runtime.database.purge_expired_leases()?;
            runtime.adopt_workers();
            runtime.recover_missing_workers();
            let idle_sweep = runtime.sweep_idle_workers()?;
            Ok(json!({
                "updated": true,
                "purged_expired_leases": purged_expired_leases,
                "worker_count": runtime.workers.lock().expect("workers mutex poisoned").len(),
                "idle_sweep": idle_sweep,
            }))
        }
        "daemon.shutdown" => Ok(json!({"shutting_down": true})),
        "preset.list" => runtime.list_presets(),
        "agent.list" => Ok(Value::Array(runtime.list_agents())),
        "agent.create" => runtime.create_agent(&command.params),
        "agent.attach" => {
            let agent_id = command
                .params
                .get("agent_id")
                .and_then(Value::as_str)
                .or(command.agent_id.as_deref())
                .context("agent.attach requires agent_id")?;
            let cursor = command.params.get("cursor").and_then(|cursor| {
                Some((
                    cursor.get("generation")?.as_u64()?,
                    cursor.get("sequence")?.as_u64()?,
                ))
            });
            let result = runtime.attach(
                agent_id,
                &command.client_id,
                attachment_id,
                event_tx,
                cursor,
            )?;
            attached_workers.insert(agent_id.to_owned(), runtime.worker_for_agent(agent_id)?);
            Ok(result)
        }
        "agent.detach" => {
            for (agent_id, worker) in attached_workers.iter() {
                worker.detach(attachment_id);
                runtime.release_control(agent_id, &command.client_id)?;
            }
            attached_workers.clear();
            Ok(json!({"detached": true}))
        }
        "agent.take_control" => {
            let agent_id = require_agent_id(command)?;
            runtime.take_control(agent_id, &command.client_id)
        }
        "agent.stop" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            runtime.stop_agent(agent_id)
        }
        "session.archive" => {
            let source = command
                .params
                .get("session_path")
                .and_then(Value::as_str)
                .context("session.archive requires session_path")?;
            let target = command
                .params
                .get("archive_path")
                .and_then(Value::as_str)
                .context("session.archive requires archive_path")?;
            runtime.archive_session(
                Path::new(source),
                Path::new(target),
                Some(&command.client_id),
            )
        }
        "agent.message.send" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            runtime.route_agent_message(command)
        }
        "agent.message.receive"
        | "agent.message.record_sent"
        | "subagent.invoke"
        | "subagent.passivate"
        | "automation.resolve" => {
            bail!("method is private to the daemon-worker protocol")
        }
        "schedule.add" | "schedule.update" | "schedule.pause" | "schedule.resume"
        | "schedule.cancel" | "goal.set" | "goal.update" | "goal.pause" | "goal.cancel"
        | "goal.complete" | "goal.resume" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            // Serialize stopping a goal with continuation admission. A turn
            // admitted before this fence may finish, but no later one starts.
            let goal_fence = if matches!(
                command.method.as_str(),
                "goal.pause" | "goal.cancel" | "goal.complete"
            ) {
                let root_id = runtime.root_agent_id_for(agent_id)?;
                runtime
                    .workers
                    .lock()
                    .expect("workers mutex poisoned")
                    .values()
                    .find(|worker| worker.descriptor.root_agent_id == root_id)
                    .cloned()
            } else {
                None
            };
            let _goal_guard = goal_fence.as_ref().map(|worker| {
                worker
                    .lifecycle
                    .lock()
                    .expect("worker lifecycle mutex poisoned")
            });
            let result = automation_operation(
                &runtime.database,
                agent_id,
                &command.method,
                &command.params,
            )?;
            if command.method == "goal.resume" {
                let goal_id = result["goal_id"].as_str().context("goal has no id")?;
                let continuation = GoalContinuation {
                    previous_request_id: result["last_request_id"].as_str().map(str::to_owned),
                    goal_id: goal_id.to_owned(),
                    agent_id: agent_id.to_owned(),
                    objective: result["objective"].as_str().unwrap_or_default().to_owned(),
                    continuation_count: result["continuation_count"].as_u64().unwrap_or(0),
                    max_continuations: result["max_continuations"].as_u64().unwrap_or(0),
                };
                let worker = match runtime.worker_for_agent(agent_id) {
                    Ok(worker) => worker,
                    Err(error) => {
                        runtime
                            .database
                            .mark_goal_error(goal_id, &error.to_string())?;
                        return Err(error);
                    }
                };
                spawn_goal_continuation(worker, runtime.database.clone(), continuation);
                return Ok(json!({"goal":result,"run":{"queued":true}}));
            }
            if command.method == "goal.set" {
                let goal_id = result["goal_id"].as_str().context("goal has no id")?;
                let objective = result["objective"]
                    .as_str()
                    .context("goal has no objective")?;
                let pending_run: Option<String> = runtime.database.connection()?.query_row(
                    "SELECT r.request_id FROM goal_runs r JOIN tasks t ON t.run_id=r.request_id WHERE r.goal_id=?1 AND r.status='running' AND t.status='running' LIMIT 1",
                    params![goal_id], |row| row.get(0)).optional()?;
                if let Some(request_id) = pending_run {
                    return Ok(
                        json!({"goal": result, "run": {"request_id": request_id, "existing": true}}),
                    );
                }
                match runtime.submit_turn(agent_id, json!({"message": objective}), Some(goal_id)) {
                    Ok(run) => Ok(json!({"goal": result, "run": run})),
                    Err(error) => {
                        let _ = runtime
                            .database
                            .mark_goal_error(goal_id, &error.to_string());
                        Err(error)
                    }
                }
            } else {
                Ok(result)
            }
        }
        "schedule.list" | "goal.list" => {
            let agent_id = command
                .params
                .get("agent_id")
                .and_then(Value::as_str)
                .or(command.agent_id.as_deref());
            if command.method == "schedule.list" {
                Ok(json!(runtime.database.list_schedules(agent_id)?))
            } else {
                Ok(json!(runtime.database.list_goals(agent_id)?))
            }
        }
        "goal.status" => automation_operation(
            &runtime.database,
            require_agent_id(command)?,
            &command.method,
            &command.params,
        ),
        "frontend.exit" => Ok(json!({"exiting": true, "detached": true})),
        method => {
            let agent_id = require_agent_id(command)?;
            if wire::mutation(method) {
                runtime.assert_controller(agent_id, &command.client_id)?;
            }
            if wire::worker_method(method) == "turn.submit" {
                return runtime.submit_turn(agent_id, command.params.clone(), None);
            }
            let worker = runtime.worker_for_agent(agent_id)?;
            let root_agent_id = runtime.root_agent_id_for(agent_id)?;
            let worker_method = wire::worker_method(method);
            let result = if root_agent_id == agent_id {
                worker.call(worker_method, command.params.clone(), WORKER_RPC_TIMEOUT)?
            } else {
                worker.call(
                    "subagent.invoke",
                    json!({
                        "agent_id": agent_id,
                        "method": worker_method,
                        "params": command.params
                    }),
                    WORKER_RPC_TIMEOUT,
                )?
            };
            if worker_method == "session.snapshot" {
                Ok(decorate_snapshot(
                    &worker.descriptor,
                    worker.generation.load(Ordering::SeqCst),
                    agent_id,
                    worker.sequence.load(Ordering::SeqCst),
                    result,
                ))
            } else {
                Ok(result)
            }
        }
    }
}

fn configured_max_workers() -> usize {
    env_var("QI_AGENT_MAX_WORKERS", "DAO_MAX_WORKERS")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(8)
}

fn configured_idle_eviction() -> Option<Duration> {
    let raw = env_var(
        "QI_AGENT_IDLE_EVICTION_MINUTES",
        "DAO_IDLE_EVICTION_MINUTES",
    )
    .unwrap_or_else(|| "90".into());
    if matches!(raw.trim().to_ascii_lowercase().as_str(), "off" | "none") {
        return None;
    }
    let minutes = raw
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(90.0);
    let milliseconds = (minutes * 60_000.0).min(u64::MAX as f64) as u64;
    Some(Duration::from_millis(milliseconds.max(1)))
}

fn idle_sweep_interval(threshold: Option<Duration>) -> Duration {
    let Some(threshold) = threshold else {
        return Duration::from_secs(5 * 60);
    };
    let one_minute = Duration::from_secs(60);
    let five_minutes = Duration::from_secs(5 * 60);
    (threshold / 3).clamp(one_minute, five_minutes)
}

fn idle_eviction_status(runtime: &Runtime) -> Value {
    let threshold = configured_idle_eviction();
    json!({
        "enabled": threshold.is_some(),
        "threshold_minutes": threshold.map(|value| value.as_secs_f64() / 60.0),
        "sweep_interval_minutes": idle_sweep_interval(threshold).as_secs_f64() / 60.0,
        "last_sweep_at_ms": runtime.last_idle_sweep_at_ms.load(Ordering::SeqCst),
        "next_sweep_at_ms": runtime.next_idle_sweep_at_ms.load(Ordering::SeqCst),
        "running": runtime.idle_sweep_running.load(Ordering::SeqCst),
    })
}

fn inspect_session_idle(
    summary: &Value,
    agent_id: &str,
    now: u128,
    threshold_ms: u128,
    newest_activity: &mut Option<u128>,
    pin_reasons: &mut Vec<String>,
) {
    if summary.get("activity").and_then(Value::as_str) != Some("idle") {
        pin_reasons.push(format!("busy:{agent_id}"));
    }
    let Some(activity) = summary
        .get("last_activity_at_ms")
        .and_then(Value::as_u64)
        .map(u128::from)
    else {
        pin_reasons.push(format!("invalid-activity-time:{agent_id}"));
        return;
    };
    *newest_activity = Some(newest_activity.map_or(activity, |current| current.max(activity)));
    if now.saturating_sub(activity) < threshold_ms {
        pin_reasons.push(format!("recent-activity:{agent_id}"));
    }
}

fn idle_inspection_value(
    worker: &WorkerConnection,
    inspection: &IdleInspection,
    threshold: Duration,
    evicted: bool,
) -> Value {
    let idle_age_minutes = inspection
        .last_activity_at_ms
        .map(|activity| now_ms().saturating_sub(activity) as f64 / 60_000.0);
    json!({
        "worker_id": worker.descriptor.worker_id,
        "agent_id": worker.descriptor.root_agent_id,
        "evicted": evicted,
        "idle_eviction_eligible": inspection.eligible,
        "idle_pin_reasons": inspection.pin_reasons,
        "last_activity_at_ms": inspection.last_activity_at_ms,
        "idle_age_minutes": idle_age_minutes,
        "idle_eviction_threshold_minutes": threshold.as_secs_f64() / 60.0,
        "session_count": inspection.agent_ids.len(),
    })
}

fn wait_for_worker_stop(path: &Path, pid: Option<u32>, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        if !process_alive(pid)
            || read_descriptor(path)
                .ok()
                .is_some_and(|descriptor| descriptor.status == "stopped")
        {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(40));
    }
}

fn configured_max_tokens_per_run() -> Option<u64> {
    env_var("QI_AGENT_MAX_TOKENS_PER_RUN", "DAO_MAX_TOKENS_PER_RUN")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn configured_allowed_providers() -> Vec<String> {
    env_var("QI_AGENT_ALLOWED_PROVIDERS", "DAO_ALLOWED_PROVIDERS")
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn enforce_model_quotas(parameters: &Value) -> Result<()> {
    let model_options = parameters
        .pointer("/options/model-options")
        .or_else(|| parameters.pointer("/options/model_options"));
    let provider = model_options
        .and_then(|options| options.get("provider"))
        .and_then(Value::as_str);
    let allowed = configured_allowed_providers();
    if !allowed.is_empty() {
        let provider = provider.context(
            "turn must select options.model_options.provider when QI_AGENT_ALLOWED_PROVIDERS is set",
        )?;
        if !allowed.iter().any(|entry| entry == provider) {
            bail!("provider is outside the daemon allowlist: {provider}")
        }
    }
    if let Some(maximum) = configured_max_tokens_per_run() {
        for key in ["max_tokens", "max_output_tokens"] {
            if let Some(requested) = model_options
                .and_then(|options| options.get(key))
                .and_then(Value::as_u64)
                && requested > maximum
            {
                bail!("requested {key}={requested} exceeds daemon quota {maximum}")
            }
        }
    }
    Ok(())
}

fn validate_turn_message(message: &Value) -> Result<()> {
    if let Some(text) = message.as_str() {
        if text.is_empty() {
            bail!("turn message cannot be empty")
        }
        if text.len() > 256 * 1024 {
            bail!("turn message exceeds the 256 KiB limit")
        }
        return Ok(());
    }
    let blocks = message
        .as_array()
        .context("turn message must be text or typed content blocks")?;
    if blocks.is_empty() || blocks.len() > 9 {
        bail!("turn message requires 1 through 9 content blocks")
    }
    if serde_json::to_vec(message)?.len() > 256 * 1024 {
        bail!("turn message references exceed the 256 KiB limit")
    }
    let mut content = false;
    for block in blocks {
        let object = block
            .as_object()
            .context("turn content block must be an object")?;
        match object.get("type").and_then(Value::as_str) {
            Some("text") => {
                if object.len() != 2 {
                    bail!("text blocks require only type and text")
                }
                let text = object
                    .get("text")
                    .and_then(Value::as_str)
                    .context("text block requires text")?;
                content |= !text.is_empty();
            }
            Some("attachment") => {
                if object.len() != 6 {
                    bail!("attachment blocks require type,id,name,mime,size,workspaceId")
                }
                let id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .context("attachment requires id")?;
                if !(8..=128).contains(&id.len())
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    bail!("invalid attachment id")
                }
                let workspace = object
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .context("attachment requires workspaceId")?;
                if workspace.len() != 16
                    || !workspace
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    bail!("invalid attachment workspaceId")
                }
                for (field, max) in [("name", 180), ("mime", 100)] {
                    let value = object
                        .get(field)
                        .and_then(Value::as_str)
                        .with_context(|| format!("attachment requires {field}"))?;
                    if value.is_empty() || value.chars().count() > max {
                        bail!("invalid attachment {field}")
                    }
                }
                if !object
                    .get("size")
                    .and_then(Value::as_u64)
                    .is_some_and(|size| (1..=8_388_608).contains(&size))
                {
                    bail!("invalid attachment size")
                }
                content = true;
            }
            _ => bail!("unsupported turn content block"),
        }
    }
    if !content {
        bail!("turn message cannot be empty")
    }
    Ok(())
}

fn automation_operation(
    database: &Database,
    agent_id: &str,
    method: &str,
    p: &Value,
) -> Result<Value> {
    let required_text = |key: &str| -> Result<&str> {
        let value = p
            .get(key)
            .and_then(Value::as_str)
            .with_context(|| format!("{method} requires {key}"))?;
        if value.trim().is_empty() || value.len() > 256 * 1024 {
            bail!("{key} must be between 1 byte and 256 KiB")
        }
        Ok(value)
    };
    let revision = |row: &Value, required: bool| -> Result<i64> {
        let current = row["revision"].as_i64().context("missing revision")?;
        match p.get("expected_revision") {
            Some(v) if v.as_i64() == Some(current) => Ok(current),
            Some(_) => Err(api_error(
                "revision_conflict",
                "state changed; refresh before retrying",
            )),
            None if required => bail!("expected_revision is required"),
            None => Ok(current),
        }
    };
    match method {
        "schedule.list" => return Ok(json!(database.list_schedules(Some(agent_id))?)),
        "goal.list" => return Ok(json!(database.list_goals(Some(agent_id))?)),
        "schedule.add" => {
            let (expression, next) = schedule_spec(p)?;
            return database.add_schedule(agent_id, &expression, next, &json!({
                "prompt": required_text("prompt")?, "attempts": 0,
                "timezone": p.get("timezone").and_then(Value::as_str).unwrap_or("UTC"),
                "max_attempts": p.get("max_attempts").and_then(Value::as_u64).unwrap_or(3).clamp(1,10),
                "retry_delay_ms": p.get("retry_delay_ms").and_then(Value::as_u64).unwrap_or(1000).clamp(100,60000),
            }));
        }
        "goal.set" => {
            return database.create_goal(
                agent_id,
                required_text("objective")?,
                p.get("max_continuations")
                    .and_then(Value::as_u64)
                    .unwrap_or(3)
                    .min(20),
            );
        }
        _ => {}
    }
    if method.starts_with("schedule.") {
        let id = required_text("schedule_id")?;
        let row = database
            .list_schedules(Some(agent_id))?
            .into_iter()
            .find(|row| row["schedule_id"] == id)
            .context("schedule does not belong to agent")?;
        let rev = revision(&row, method != "schedule.cancel")?;
        let old_status = row["status"].as_str().unwrap_or_default();
        let mut status = old_status;
        let mut expression = row["expression"].as_str().unwrap_or_default().to_owned();
        let mut policy = row["policy"].clone();
        let mut next = row["next_at_ms"].as_i64();
        match method {
            "schedule.cancel" => {
                status = "cancelled";
                next = None;
            }
            "schedule.pause" if old_status == "active" => {
                status = "paused";
                next = None;
            }
            "schedule.resume" if matches!(old_status, "paused" | "failed") => {
                if old_status == "failed" {
                    policy["attempts"] = json!(0);
                }
                let zone = policy
                    .get("timezone")
                    .and_then(Value::as_str)
                    .unwrap_or("UTC");
                next = if let Some(at) = expression
                    .strip_prefix("at:")
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    (at > now_ms_i64()).then_some(at)
                } else {
                    next_schedule_time_in_zone(&expression, now_ms_i64(), zone)
                };
                if next.is_none() {
                    bail!("schedule has no future occurrence; update its time before resuming")
                }
                status = "active";
            }
            "schedule.update" if matches!(old_status, "active" | "paused" | "failed") => {
                if p.get("prompt").is_some() {
                    policy["prompt"] = json!(required_text("prompt")?);
                }
                if let Some(zone) = p.get("timezone") {
                    zone.as_str()
                        .context("timezone must be a string")?
                        .parse::<Tz>()
                        .context("invalid IANA timezone")?;
                    policy["timezone"] = zone.clone();
                }
                let mut spec = p.clone();
                let has_spec = [
                    "at_ms",
                    "delay_ms",
                    "every_ms",
                    "expression",
                    "daily",
                    "weekly",
                ]
                .iter()
                .any(|key| p.get(*key).is_some());
                if has_spec || p.get("timezone").is_some() {
                    if !has_spec {
                        if let Some(at) = expression
                            .strip_prefix("at:")
                            .and_then(|s| s.parse::<i64>().ok())
                        {
                            spec["at_ms"] = json!(at);
                        } else {
                            spec["expression"] = json!(expression);
                        }
                    }
                    spec["timezone"] = policy.get("timezone").cloned().unwrap_or(json!("UTC"));
                    let (updated, at) = schedule_spec(&spec)?;
                    expression = updated;
                    next = if status == "active" { Some(at) } else { None };
                }
            }
            _ => bail!(
                "{method} is not permitted for a {old_status} schedule; uncertain delivery requires reconciliation"
            ),
        }
        database.revise_schedule(id, rev, &expression, next, &policy, status)?;
        return database
            .list_schedules(Some(agent_id))?
            .into_iter()
            .find(|row| row["schedule_id"] == id)
            .context("schedule disappeared");
    }
    if method.starts_with("goal.") {
        let id = required_text("goal_id")?;
        let row = database
            .list_goals(Some(agent_id))?
            .into_iter()
            .find(|row| row["goal_id"] == id)
            .context("goal does not belong to agent")?;
        if method == "goal.status" {
            return Ok(row);
        }
        let rev = revision(&row, matches!(method, "goal.update" | "goal.pause"))?;
        let old_status = row["status"].as_str().unwrap_or_default();
        if matches!(old_status, "completed" | "cancelled" | "superseded") {
            bail!("goal is terminal")
        }
        let mut status = old_status;
        let mut objective = row["objective"].as_str().unwrap_or_default();
        let mut max = row["max_continuations"].as_u64().unwrap_or(3);
        match method {
            "goal.cancel" => status = "cancelled",
            "goal.complete" => status = "completed",
            "goal.pause" if old_status == "active" => status = "paused",
            "goal.resume"
                if matches!(
                    old_status,
                    "paused" | "blocked" | "uncertain" | "budget_exhausted"
                ) =>
            {
                if old_status == "uncertain"
                    && p.get("reconciled").and_then(Value::as_bool) != Some(true)
                {
                    bail!("uncertain goal requires reconciled=true after checking prior effects")
                }
                if row["continuation_count"].as_u64().unwrap_or(0) >= max {
                    bail!(
                        "goal budget exhausted; explicitly update max_continuations before resuming"
                    )
                }
                status = "active";
            }
            "goal.update" => {
                if p.get("objective").is_some() {
                    objective = required_text("objective")?;
                }
                if let Some(limit) = p.get("max_continuations") {
                    max = limit
                        .as_u64()
                        .filter(|n| *n <= 20)
                        .context("max_continuations must be 0 through 20")?;
                    if max < row["continuation_count"].as_u64().unwrap_or(0) {
                        bail!("new budget is below already used continuations")
                    }
                }
            }
            _ => bail!("{method} is not permitted for a {old_status} goal"),
        }
        database.revise_goal(id, rev, objective, max, status)?;
        return database
            .list_goals(Some(agent_id))?
            .into_iter()
            .find(|row| row["goal_id"] == id)
            .context("goal disappeared");
    }
    bail!("unsupported automation method")
}

fn schedule_spec(parameters: &Value) -> Result<(String, i64)> {
    let now = now_ms_i64();
    let selectors = [
        "at_ms",
        "delay_ms",
        "every_ms",
        "expression",
        "daily",
        "weekly",
    ];
    if selectors
        .iter()
        .filter(|key| parameters.get(**key).is_some())
        .count()
        != 1
    {
        bail!("provide exactly one of at_ms, delay_ms, every_ms, expression, daily, or weekly")
    }
    let timezone = parameters
        .get("timezone")
        .and_then(Value::as_str)
        .unwrap_or("UTC");
    timezone
        .parse::<Tz>()
        .context("timezone must be an IANA timezone name")?;
    if let Some(at_ms) = parameters.get("at_ms").and_then(Value::as_i64) {
        if at_ms <= now {
            bail!("schedule at_ms must be in the future")
        }
        return Ok((format!("at:{at_ms}"), at_ms));
    }
    if let Some(delay_ms) = parameters.get("delay_ms").and_then(Value::as_u64) {
        let delay_ms = i64::try_from(delay_ms).context("schedule delay is too large")?;
        if delay_ms <= 0 {
            bail!("schedule delay_ms must be positive")
        }
        let at_ms = now
            .checked_add(delay_ms)
            .context("schedule delay overflows timestamp")?;
        return Ok((format!("at:{at_ms}"), at_ms));
    }
    if let Some(every_ms) = parameters.get("every_ms").and_then(Value::as_u64) {
        let every_ms = i64::try_from(every_ms).context("schedule interval is too large")?;
        if every_ms < 100 {
            bail!("schedule every_ms must be at least 100")
        }
        return Ok((
            format!("@every {every_ms}ms"),
            now.checked_add(every_ms)
                .context("schedule interval overflows timestamp")?,
        ));
    }
    let clock = |value: &str| -> Result<(u32, u32)> {
        let (hour, minute) = value.split_once(':').context("time must be HH:MM")?;
        let hour: u32 = hour.parse().context("invalid hour")?;
        let minute: u32 = minute.parse().context("invalid minute")?;
        if hour > 23 || minute > 59 {
            bail!("time must be HH:MM (00:00 through 23:59)")
        }
        Ok((hour, minute))
    };
    let expression = if let Some(daily) = parameters.get("daily").and_then(Value::as_str) {
        let (hour, minute) = clock(daily)?;
        format!("{minute} {hour} * * *")
    } else if let Some(weekly) = parameters.get("weekly").and_then(Value::as_str) {
        let (days, time) = weekly
            .split_once(' ')
            .context("weekly must be MON,WED HH:MM")?;
        let (hour, minute) = clock(time.trim())?;
        format!("{minute} {hour} * * {days}")
    } else {
        parameters
            .get("expression")
            .and_then(Value::as_str)
            .context("schedule expression must be a string")?
            .to_owned()
    };
    let next = next_schedule_time_in_zone(&expression, now, timezone).with_context(|| {
        format!("invalid expression or no occurrence within eight years: {expression}")
    })?;
    Ok((expression, next))
}

#[derive(Debug)]
struct CronField {
    values: Vec<u32>,
    wildcard: bool,
}

fn cron_field(input: &str, min: u32, max: u32, names: &[&str]) -> Option<CronField> {
    let input = input.to_ascii_uppercase();
    let number = |s: &str| -> Option<u32> {
        s.parse().ok().or_else(|| {
            names
                .iter()
                .position(|name| *name == s)
                .map(|i| i as u32 + min)
        })
    };
    let mut values = Vec::new();
    for part in input.split(',') {
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            (range, step.parse::<u32>().ok()?)
        } else {
            (part, 1)
        };
        if step == 0 || step > max + 1 {
            return None;
        }
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let value = number(range)?;
            (value, if part.contains('/') { max } else { value })
        };
        if start < min || end > max || start > end {
            return None;
        }
        values.extend((start..=end).step_by(step as usize));
    }
    values.sort_unstable();
    values.dedup();
    (!values.is_empty()).then_some(CronField {
        values,
        wildcard: input.starts_with('*'),
    })
}

#[cfg(test)]
fn next_schedule_time(expression: &str, after_ms: i64) -> Option<i64> {
    next_schedule_time_in_zone(expression, after_ms, "UTC")
}

fn next_schedule_time_in_zone(expression: &str, after_ms: i64, timezone: &str) -> Option<i64> {
    let zone: Tz = timezone.parse().ok()?;
    if expression.starts_with("at:") {
        return None;
    }
    if let Some(duration) = expression.strip_prefix("@every ") {
        let milliseconds = duration.strip_suffix("ms")?.parse::<i64>().ok()?;
        return if milliseconds >= 100 {
            after_ms.checked_add(milliseconds)
        } else {
            None
        };
    }
    let fields: Vec<_> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }
    let minutes = cron_field(fields[0], 0, 59, &[])?;
    let hours = cron_field(fields[1], 0, 23, &[])?;
    let dates = cron_field(fields[2], 1, 31, &[])?;
    let months = cron_field(
        fields[3],
        1,
        12,
        &[
            "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
        ],
    )?;
    let weekdays = cron_field(
        fields[4],
        0,
        7,
        &["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
    )?;
    let after = Utc
        .timestamp_millis_opt(after_ms)
        .single()?
        .with_timezone(&zone);
    let mut date: NaiveDate = after.date_naive();
    // Search calendar days, then selected hours and minutes. A missing DST wall
    // time is skipped; an ambiguous wall time runs only at its first occurrence.
    for _ in 0..(366 * 8) {
        let dom = dates.values.contains(&date.day());
        let dow = weekdays
            .values
            .iter()
            .any(|day| day % 7 == date.weekday().num_days_from_sunday());
        let day_matches = if !dates.wildcard && !weekdays.wildcard {
            dom || dow
        } else {
            dom && dow
        };
        if months.values.contains(&date.month()) && day_matches {
            for hour in &hours.values {
                for minute in &minutes.values {
                    let wall = date.and_hms_opt(*hour, *minute, 0)?;
                    if let Some(next) = zone.from_local_datetime(&wall).earliest() {
                        let timestamp = next.timestamp_millis();
                        if timestamp > after_ms {
                            return Some(timestamp);
                        }
                    }
                }
            }
        }
        date = date.succ_opt()?;
    }
    None
}

fn spawn_scheduler(runtime: Arc<Runtime>) {
    thread::spawn(move || {
        while !runtime.shutdown.load(Ordering::SeqCst) {
            for _ in 0..8 {
                let claim = match runtime.database.claim_due_schedule() {
                    Ok(Some(claim)) => claim,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("schedule claim failed: {error:#}");
                        break;
                    }
                };
                run_schedule_claim(&runtime, claim);
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

fn spawn_idle_sweeper(runtime: Arc<Runtime>) {
    thread::spawn(move || {
        while !runtime.shutdown.load(Ordering::SeqCst) {
            let interval = idle_sweep_interval(configured_idle_eviction());
            let deadline = std::time::Instant::now() + interval;
            runtime.next_idle_sweep_at_ms.store(
                u64::try_from(now_ms().saturating_add(interval.as_millis())).unwrap_or(u64::MAX),
                Ordering::SeqCst,
            );
            while std::time::Instant::now() < deadline && !runtime.shutdown.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(250));
            }
            if runtime.shutdown.load(Ordering::SeqCst) {
                break;
            }
            if let Err(error) = runtime.sweep_idle_workers() {
                eprintln!(
                    "{}",
                    json!({"event": "idle_eviction_sweep_failed", "error": error.to_string()})
                );
            }
        }
    });
}

fn run_schedule_claim(runtime: &Runtime, claim: ScheduleClaim) {
    let prompt = claim
        .policy
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let result = runtime.submit_turn_with_id(
        &claim.agent_id,
        json!({"message": prompt}),
        None,
        Some(&claim.delivery_id),
    );
    finish_schedule_dispatch(&runtime.database, &claim, result);
}

fn finish_schedule_dispatch(database: &Database, claim: &ScheduleClaim, result: Result<Value>) {
    let mut policy = claim.policy.clone();
    if result.is_ok() {
        if let Some(object) = policy.as_object_mut() {
            object.insert("attempts".into(), json!(0));
            object.insert("last_delivery_id".into(), json!(claim.delivery_id));
            object.remove("delivery_id");
            object.remove("last_error");
        }
        let timezone = claim
            .policy
            .get("timezone")
            .and_then(Value::as_str)
            .unwrap_or("UTC");
        let next = next_schedule_time_in_zone(&claim.expression, now_ms_i64(), timezone);
        let status = if next.is_some() {
            "active"
        } else {
            "completed"
        };
        let _ = database.finish_schedule_claim(claim, status, next, &policy);
        return;
    }
    let error = result.unwrap_err().to_string();
    if uncertain_worker_failure(&error) {
        if let Some(object) = policy.as_object_mut() {
            object.insert("last_error".into(), json!(error));
        }
        let _ = database.finish_schedule_claim(claim, "uncertain", None, &policy);
        return;
    }
    let attempts = policy
        .get("attempts")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    let max_attempts = policy
        .get("max_attempts")
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .clamp(1, 10);
    if let Some(object) = policy.as_object_mut() {
        object.insert("attempts".into(), json!(attempts));
        object.insert("last_error".into(), json!(error));
    }
    let (status, next) = if attempts >= max_attempts {
        ("failed", None)
    } else {
        let base = policy
            .get("retry_delay_ms")
            .and_then(Value::as_u64)
            .unwrap_or(1_000)
            .clamp(100, 60_000);
        let exponent = u32::try_from(attempts.saturating_sub(1).min(6)).unwrap_or(6);
        let delay = base
            .saturating_mul(2u64.saturating_pow(exponent))
            .min(60_000);
        (
            "active",
            Some(now_ms_i64().saturating_add(i64::try_from(delay).unwrap_or(60_000))),
        )
    };
    let _ = database.finish_schedule_claim(claim, status, next, &policy);
}

fn current_goal_continuation(
    database: &Database,
    continuation: &GoalContinuation,
) -> Result<Option<Value>> {
    Ok(database
        .list_goals(Some(&continuation.agent_id))?
        .into_iter()
        .find(|goal| {
            goal["goal_id"] == continuation.goal_id
                && goal["status"] == "active"
                && goal["continuation_count"].as_u64() == Some(continuation.continuation_count)
                && goal["last_request_id"].as_str() == continuation.previous_request_id.as_deref()
        }))
}

fn spawn_goal_continuation(
    connection: Arc<WorkerConnection>,
    database: Database,
    continuation: GoalContinuation,
) {
    thread::spawn(move || {
        let owner = &connection.descriptor.root_agent_id;
        let _lifecycle = connection
            .lifecycle
            .lock()
            .expect("worker lifecycle mutex poisoned");
        let current_goal = match current_goal_continuation(&database, &continuation) {
            Ok(Some(goal)) => goal,
            Ok(None) => return,
            Err(error) => {
                let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
                return;
            }
        };
        // Resuming a paused-but-still-running turn arms its ordinary completion;
        // it must not submit an additional turn alongside the existing one.
        let running = database.connection().and_then(|db| db.query_row(
            "SELECT 1 FROM goal_runs r JOIN tasks t ON t.run_id=r.request_id WHERE r.goal_id=?1 AND r.status='running' AND t.status='running' LIMIT 1",
            params![continuation.goal_id], |_| Ok(())).optional().map_err(Into::into));
        match running {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(error) => {
                let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
                return;
            }
        }
        if let Err(error) =
            database.acquire_workspace_lease(&connection.descriptor.workspace_id, owner)
        {
            let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
            return;
        }
        let prompt = format!(
            "Continue the durable goal below. Inspect the current session and workspace, make the next safe unit of progress, and report blockers explicitly.\n\nGoal: {}\n\nContinuation {}/{}.",
            current_goal["objective"]
                .as_str()
                .unwrap_or(&continuation.objective),
            continuation.continuation_count,
            current_goal["max_continuations"]
                .as_u64()
                .unwrap_or(continuation.max_continuations),
        );
        let request_id = Uuid::new_v4().to_string();
        if let Err(error) = database
            .record_task(&continuation.agent_id, &request_id)
            .and_then(|_| database.record_goal_run(&continuation.goal_id, &request_id))
        {
            let _ = database.finish_task(&request_id, false);
            let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
            let _ = database.release_workspace_lease(&connection.descriptor.workspace_id, owner);
            return;
        }
        let result = if continuation.agent_id == connection.descriptor.root_agent_id {
            connection.call_inner(
                "turn.submit",
                json!({"message": prompt,"request_id":request_id}),
                WORKER_RPC_TIMEOUT,
            )
        } else {
            connection.call_inner(
                "subagent.invoke",
                json!({
                    "agent_id": continuation.agent_id,
                    "method": "turn.submit",
                    "params": {"message": prompt,"request_id":request_id},
                }),
                WORKER_RPC_TIMEOUT,
            )
        };
        match result {
            Ok(result) => {
                if result.get("request_id").and_then(Value::as_str) == Some(request_id.as_str()) {
                    return;
                }
                let _ = database.mark_goal_error(
                    &continuation.goal_id,
                    "continued goal was accepted without a durable request id",
                );
                let _ = database.retain_uncertain_workspace_lease(
                    &connection.descriptor.workspace_id,
                    owner,
                    Some(&request_id),
                );
                return;
            }
            Err(error) => {
                let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
                if uncertain_worker_failure(&error.to_string()) {
                    let _ = database.retain_uncertain_workspace_lease(
                        &connection.descriptor.workspace_id,
                        owner,
                        Some(&request_id),
                    );
                    return;
                }
            }
        }
        let _ = database.finish_task(&request_id, false);
        let _ = database.finish_goal_run_failed(&request_id);
        let _ = database.release_workspace_lease(&connection.descriptor.workspace_id, owner);
    });
}

fn schedule_shutdown(runtime: &Arc<Runtime>) {
    let runtime = Arc::clone(runtime);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        runtime.shutdown.store(true, Ordering::SeqCst);
    });
}

fn connect_worker(
    descriptor: WorkerDescriptor,
    database: Database,
) -> Result<Arc<WorkerConnection>> {
    let mut stream = UnixStream::connect(&descriptor.socket_path).with_context(|| {
        format!(
            "could not connect to worker {}",
            descriptor.socket_path.display()
        )
    })?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    serde_json::to_writer(
        &mut stream,
        &json!({"version": 1, "type": "worker.auth", "token": descriptor.token}),
    )?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut registration = String::new();
    reader.read_line(&mut registration)?;
    let registration: Value = serde_json::from_str(registration.trim())?;
    if registration.get("type").and_then(Value::as_str) != Some("worker.register")
        || registration.get("worker_id").and_then(Value::as_str)
            != Some(descriptor.worker_id.as_str())
    {
        bail!("worker registration did not match descriptor")
    }
    stream.set_read_timeout(None)?;
    let connection = Arc::new(WorkerConnection {
        sequence: AtomicU64::new(0),
        generation: AtomicU64::new(descriptor.generation),
        status: Mutex::new(descriptor.status.clone()),
        descriptor,
        writer: Mutex::new(BufWriter::new(stream)),
        pending: Mutex::new(HashMap::new()),
        events: Mutex::new(VecDeque::new()),
        attachments: Mutex::new(HashMap::new()),
        alive: AtomicBool::new(true),
        lifecycle: Mutex::new(()),
    });
    let reader_connection = Arc::clone(&connection);
    thread::spawn(move || worker_reader(reader_connection, reader, database));
    Ok(connection)
}

fn handle_automation_request(connection: Arc<WorkerConnection>, database: Database, event: Value) {
    thread::spawn(move || {
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        let Some(id) = data.get("id").and_then(Value::as_str) else {
            return;
        };
        let agent_id = &connection.descriptor.root_agent_id;
        let method = data
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let p = data.get("params").cloned().unwrap_or(json!({}));
        let result = (|| -> Result<Value> {
            if event
                .get("agent_id")
                .and_then(Value::as_str)
                .is_some_and(|sender| sender != agent_id)
            {
                bail!("automation is only available to the root agent")
            }
            if !matches!(
                method,
                "schedule.add"
                    | "schedule.list"
                    | "schedule.update"
                    | "schedule.pause"
                    | "schedule.resume"
                    | "schedule.cancel"
                    | "goal.set"
                    | "goal.list"
                    | "goal.status"
                    | "goal.update"
                    | "goal.pause"
                    | "goal.resume"
                    | "goal.cancel"
                    | "goal.complete"
            ) {
                bail!("unsupported automation method")
            }
            let client_id = format!("automation:{agent_id}");
            let command = PublicCommand {
                client_id: client_id.clone(),
                command_id: Some(id.into()),
                agent_id: Some(agent_id.clone()),
                method: method.into(),
                params: p.clone(),
                ..Default::default()
            };
            match database.begin_command(&command)? {
                JournalEntry::Completed(value) => return Ok(value),
                JournalEntry::Failed(error) => bail!("{}", error),
                JournalEntry::Pending => {
                    bail!("automation outcome is uncertain; inspect state before any retry")
                }
                JournalEntry::New => {}
            }
            let outcome = (|| -> Result<Value> {
                // The model already occupies a turn. Bind the goal to that run;
                // never submit a nested turn and wait on the same worker.
                let current_run = if matches!(method, "goal.set" | "goal.resume") {
                    Some(database.connection()?.query_row(
                        "SELECT run_id FROM tasks WHERE agent_id=?1 AND status='running' ORDER BY created_at_ms DESC LIMIT 1",
                        params![agent_id], |row| row.get::<_, String>(0)).context("goal tool requires a daemon-managed active turn")?)
                } else {
                    None
                };
                if method == "goal.set"
                    && let Some(run_id) = &current_run
                    && database.goal_id_for_run(run_id)?.is_some()
                {
                    bail!(
                        "this turn is already bound to a goal; finish it before creating another goal"
                    )
                }
                let result = automation_operation(&database, agent_id, method, &p)?;
                if let Some(run_id) = current_run {
                    let goal_id = result["goal_id"].as_str().context("goal id is missing")?;
                    database.record_goal_run(goal_id, &run_id)?;
                }
                Ok(result)
            })();
            match &outcome {
                Ok(value) => database.finish_command(&client_id, id, "completed", value)?,
                Err(error) => database.finish_command(
                    &client_id,
                    id,
                    "failed",
                    &json!({"message": error.to_string()}),
                )?,
            }
            outcome
        })();
        let response = match result {
            Ok(value) => json!({"id": id, "ok": true, "result": value}),
            Err(error) => json!({"id": id, "ok": false, "error": error.to_string()}),
        };
        // This private method is explicitly rejected by the public dispatcher.
        // Keep the reader available to receive its acknowledgment.
        let _ = connection.call_inner("automation.resolve", response, Duration::from_secs(10));
    });
}

fn worker_reader(
    connection: Arc<WorkerConnection>,
    reader: BufReader<UnixStream>,
    database: Database,
) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "ready" {
            if let Some(generation) = value.get("generation").and_then(Value::as_u64) {
                connection.generation.store(generation, Ordering::SeqCst);
            }
            *connection
                .status
                .lock()
                .expect("worker status mutex poisoned") = "idle".into();
            continue;
        }
        if kind == "response" {
            let response_id = value.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(id) = response_id
                && let Some(sender) = connection
                    .pending
                    .lock()
                    .expect("worker pending mutex poisoned")
                    .remove(&id)
            {
                let _ = sender.send(value);
            }
            continue;
        }
        if kind == "event"
            && value.get("event").and_then(Value::as_str) == Some("automation/request")
        {
            handle_automation_request(Arc::clone(&connection), database.clone(), value);
            continue;
        }
        if matches!(kind, "event" | "run-result") {
            let event_generation = value
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| connection.generation.load(Ordering::SeqCst));
            let previous_generation = connection
                .generation
                .swap(event_generation, Ordering::SeqCst);
            if previous_generation != event_generation {
                connection
                    .events
                    .lock()
                    .expect("worker events mutex poisoned")
                    .clear();
            }
            if value.get("event").and_then(Value::as_str) == Some("worker/exited") {
                let _ = database.release_workspace_lease(
                    &connection.descriptor.workspace_id,
                    &connection.descriptor.root_agent_id,
                );
                *connection
                    .status
                    .lock()
                    .expect("worker status mutex poisoned") = "failed".into();
                let pending = std::mem::take(
                    &mut *connection
                        .pending
                        .lock()
                        .expect("worker pending mutex poisoned"),
                );
                for (id, sender) in pending {
                    let _ = sender.send(json!({
                        "type": "response",
                        "id": id,
                        "ok": false,
                        "error": {
                            "message": "worker exited before the RPC outcome was durable; outcome is uncertain",
                            "data": {"status": "uncertain"}
                        }
                    }));
                }
            }
            if value.get("event").and_then(Value::as_str) == Some("worker/restarting") {
                *connection
                    .status
                    .lock()
                    .expect("worker status mutex poisoned") = "recovering".into();
            }
            if value.get("event").and_then(Value::as_str) == Some("remote/run-result")
                && let Some(request_id) = value
                    .pointer("/data/request_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            {
                let ok = value
                    .pointer("/data/ok")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let _ = database.finish_task(&request_id, ok);
                let _ = database.release_workspace_lease_after_run(
                    &connection.descriptor.workspace_id,
                    &connection.descriptor.root_agent_id,
                    &request_id,
                );
                if ok {
                    if let Ok(Some(continuation)) = database.finish_goal_run(&request_id) {
                        spawn_goal_continuation(
                            Arc::clone(&connection),
                            database.clone(),
                            continuation,
                        );
                    }
                } else if let Ok(Some(goal_id)) = database.goal_id_for_run(&request_id) {
                    let message = value
                        .pointer("/data/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("goal turn failed");
                    let _ = database.mark_goal_error(&goal_id, message);
                    let _ = database.finish_goal_run_failed(&request_id);
                }
            }
            let next = value
                .pointer("/cursor/sequence")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| connection.sequence.fetch_add(1, Ordering::SeqCst) + 1);
            connection.sequence.fetch_max(next, Ordering::SeqCst);
            if let Some(object) = value.as_object_mut() {
                object
                    .entry("agent_id")
                    .or_insert(json!(connection.descriptor.root_agent_id));
                object
                    .entry("generation")
                    .or_insert(json!(event_generation));
                object.entry("cursor").or_insert(json!({
                    "generation": event_generation,
                    "sequence": next
                }));
            }
            let mut events = connection
                .events
                .lock()
                .expect("worker events mutex poisoned");
            events.push_back(value.clone());
            while events.len() > PUBLIC_EVENT_BUFFER_LIMIT {
                events.pop_front();
            }
            drop(events);
            connection.broadcast(value);
        }
    }
    // A transport failure does not prove the writer or its tools stopped.
    // Retain its workspace lease until recovery has retired the old process tree.
    let _ = database.retain_uncertain_workspace_lease(
        &connection.descriptor.workspace_id,
        &connection.descriptor.root_agent_id,
        None,
    );
    let pending = std::mem::take(
        &mut *connection
            .pending
            .lock()
            .expect("worker pending mutex poisoned"),
    );
    for (id, sender) in pending {
        let _ = sender.send(json!({"type":"response", "id":id, "ok":false,
            "error":{"message":"worker disconnected before the RPC outcome was durable; outcome is uncertain"}}));
    }
    *connection
        .status
        .lock()
        .expect("worker status mutex poisoned") = "unavailable".into();
    connection.alive.store(false, Ordering::SeqCst);
    for (agent_id, sender) in connection
        .attachments
        .lock()
        .expect("worker attachments mutex poisoned")
        .values()
    {
        let error = json!({
            "version": 1,
            "type": "event",
            "agent_id": agent_id,
            "event": "worker/disconnected",
            "durable": false,
            "generation": connection.generation.load(Ordering::SeqCst),
            "data": {"worker_id": connection.descriptor.worker_id}
        });
        let _ = sender.try_send(error.clone());
    }
}

fn spawn_worker_proxy(descriptor_path: &Path) -> Result<u32> {
    let descriptor = read_descriptor(descriptor_path)?;
    let paths = RuntimePaths::discover()?;
    let log_path = paths
        .logs_dir
        .join(format!("worker-{}.log", descriptor.worker_id));
    rotate_log_if_needed(
        &log_path,
        configured_log_max_bytes(),
        configured_log_backups(),
    )?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    set_owner_only_file(&log_path)?;
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .arg("worker")
        .arg("serve")
        .arg("--descriptor")
        .arg(descriptor_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .context("could not launch resident worker proxy")?;
    let pid = child.id();
    // Keep a reaper: dropping Child without wait leaves dead proxies as zombies,
    // which kill(pid, 0) would continue to report as live.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

fn retain_worker_identity(
    descriptor: &mut WorkerDescriptor,
    known: &WorkerDescriptor,
) -> Result<()> {
    if descriptor.worker_id != known.worker_id || descriptor.generation != known.generation {
        bail!("desktop worker identity generation is UNKNOWN; retaining cleanup state");
    }
    // A stopped descriptor may already have cleared these fields. Retain the
    // connection's recorded identity until actual process/group absence wins.
    descriptor.pid = descriptor.pid.or(known.pid);
    descriptor.child_pid = descriptor.child_pid.or(known.child_pid);
    descriptor.child_process_group = descriptor.child_process_group.or(known.child_process_group);
    for helper in &known.owned_helpers {
        if !descriptor.owned_helpers.contains(helper) {
            descriptor.owned_helpers.push(helper.clone());
        }
    }
    Ok(())
}

fn check_desktop_process_observations(descriptor: &WorkerDescriptor) -> Result<()> {
    for pid in [descriptor.pid, descriptor.child_pid].into_iter().flatten() {
        crate::desktop_owner::process_presence(pid, false)?;
    }
    for group in [descriptor.pid, descriptor.child_process_group]
        .into_iter()
        .flatten()
    {
        crate::desktop_owner::process_presence(group, true)?;
    }
    for helper in &descriptor.owned_helpers {
        crate::desktop_owner::helper_present(helper)?;
    }
    Ok(())
}

fn final_retired_identity(
    mut latest: WorkerDescriptor,
    known: &WorkerDescriptor,
) -> Result<WorkerDescriptor> {
    // An absent/cleared PID is expected on normal stop. A different/new PID
    // has not been proven absent and must never pass a stale cleanup snapshot.
    for (observed, recorded) in [
        (latest.pid, known.pid),
        (latest.child_pid, known.child_pid),
        (latest.child_process_group, known.child_process_group),
    ] {
        if observed.is_some() && observed != recorded {
            bail!("final desktop worker process identity changed; cleanup UNKNOWN");
        }
    }
    retain_worker_identity(&mut latest, known)?;
    Ok(latest)
}

fn retire_orphaned_worker(
    descriptor: &WorkerDescriptor,
    strict: bool,
    descriptor_path: &Path,
) -> Result<()> {
    let alive = |pid: Option<u32>| -> Result<bool> {
        if strict {
            match pid {
                Some(pid) => crate::desktop_owner::process_presence(pid, false),
                None => Ok(false),
            }
        } else {
            Ok(process_alive(pid))
        }
    };
    let group_alive = |group: u32| -> Result<bool> {
        if strict {
            crate::desktop_owner::process_presence(group, true)
        } else {
            Ok(unsafe { libc::kill(-(group as i32), 0) } == 0)
        }
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while alive(descriptor.pid)? && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if alive(descriptor.pid)? {
        bail!("existing worker proxy is still alive; refusing a second session writer")
    }
    // The proxy stdout reader can admit a guardian until the proxy actually
    // exits. Read its final durable record only after proving that absence;
    // an earlier stop/archive snapshot cannot close this registration race.
    let final_descriptor;
    let descriptor = if strict {
        final_descriptor = final_retired_identity(
            read_descriptor(descriptor_path)
                .context("final desktop worker descriptor unavailable; cleanup UNKNOWN")?,
            descriptor,
        )?;
        &final_descriptor
    } else {
        descriptor
    };
    if let Some(group) = descriptor.pid {
        let child_group = descriptor.child_process_group.unwrap_or(group);
        if descriptor.child_process_group.is_some()
            && descriptor.child_pid.is_some_and(|pid| pid != child_group)
        {
            bail!("orphan worker process group does not match its recorded child")
        }
        if let Some(child_pid) = descriptor.child_pid
            && alive(Some(child_pid))?
            && unsafe { libc::getpgid(child_pid as i32) } != child_group as i32
        {
            bail!("orphan worker process ownership could not be verified")
        }
        // New watchdog workers have an explicitly recorded BB group. Legacy
        // workers share the proxy group. Retire both before another writer.
        let mut groups = vec![group, child_group];
        groups.sort_unstable();
        groups.dedup();
        for group in groups {
            if group_alive(group)? {
                terminate_worker_process_group(Some(group));
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while group_alive(group)? && std::time::Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                }
                if group_alive(group)? {
                    bail!("orphan worker tools have not exited; refusing a second session writer")
                }
            }
        }
    } else {
        if alive(descriptor.child_pid)? {
            bail!("orphan worker has no recorded process group")
        }
        if strict
            && let Some(group) = descriptor.child_process_group
            && group_alive(group)?
        {
            bail!("orphan worker group remains without a recorded proxy identity");
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !crate::desktop_owner::helpers_absent(&descriptor.owned_helpers)? {
        if std::time::Instant::now() >= deadline {
            bail!("owned terminal guardian cleanup UNKNOWN; descriptor retained");
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn terminate_worker_groups(descriptor: &WorkerDescriptor) {
    if let Some(group) = descriptor.child_process_group {
        terminate_worker_process_group(Some(group));
    }
    terminate_worker_process_group(descriptor.pid);
}

fn terminate_worker_process_group(pid: Option<u32>) {
    let Some(pid) = pid.and_then(|value| i32::try_from(value).ok()) else {
        return;
    };
    // Worker proxies are launched with setsid(), so their PID is also the
    // process-group ID. Escalate only this worker tree after a short grace.
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(200));
    if unsafe { libc::kill(-pid, 0) } == 0 {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

fn terminate_failed_worker_start(
    descriptor_path: &Path,
    remove_descriptor: bool,
    fallback_pid: Option<u32>,
) {
    let Ok(mut descriptor) = read_descriptor(descriptor_path) else {
        terminate_worker_process_group(fallback_pid);
        if remove_descriptor {
            let _ = fs::remove_file(descriptor_path);
        }
        return;
    };
    // The proxy can time out before publishing its PID into the descriptor.
    descriptor.pid = descriptor.pid.or(fallback_pid);
    terminate_worker_groups(&descriptor);
    let _ = fs::remove_file(&descriptor.socket_path);
    if remove_descriptor {
        let _ = fs::remove_file(descriptor_path);
    } else {
        descriptor.pid = None;
        descriptor.child_pid = None;
        descriptor.status = "stopped".into();
        let _ = write_descriptor(descriptor_path, &descriptor);
    }
}

fn wait_for_worker(path: &Path, timeout: Duration) -> Result<WorkerDescriptor> {
    let started = std::time::Instant::now();
    loop {
        if let Ok(descriptor) = read_descriptor(path)
            && descriptor.status == "running"
            && descriptor.session_id.is_some()
            && descriptor.socket_path.exists()
        {
            return Ok(descriptor);
        }
        if started.elapsed() >= timeout {
            bail!("resident worker did not become ready before timeout")
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn write_value(writer: &Arc<Mutex<BufWriter<UnixStream>>>, value: &Value) -> Result<()> {
    let mut writer = writer.lock().expect("client writer mutex poisoned");
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn write_command_response(
    writer: &Arc<Mutex<BufWriter<UnixStream>>>,
    request_id: &str,
    mut result: Value,
) -> Result<()> {
    let snapshot = if let Some(value) = result.get("snapshot") {
        Some((true, value.clone()))
    } else if result.get("session_id").is_some() && result.get("events").is_some() {
        Some((false, result.clone()))
    } else {
        None
    };
    let Some((nested, snapshot)) = snapshot else {
        return write_value(writer, &wire::response(request_id, result));
    };
    let serialized = serde_json::to_string(&snapshot)?;
    if serialized.len() <= SNAPSHOT_INLINE_LIMIT {
        return write_value(writer, &wire::response(request_id, result));
    }

    let transfer_id = format!("snapshot-{}", Uuid::new_v4());
    let chunks = chunk_text(&serialized, SNAPSHOT_CHUNK_CHARS);
    write_value(
        writer,
        &json!({
            "version": PROTOCOL_VERSION,
            "type": "snapshot.begin",
            "transfer_id": transfer_id,
            "chunks": chunks.len(),
            "bytes": serialized.len()
        }),
    )?;
    for (index, chunk) in chunks.iter().enumerate() {
        write_value(
            writer,
            &json!({
                "version": PROTOCOL_VERSION,
                "type": "snapshot.chunk",
                "transfer_id": transfer_id,
                "index": index,
                "data": chunk
            }),
        )?;
    }
    write_value(
        writer,
        &json!({
            "version": PROTOCOL_VERSION,
            "type": "snapshot.end",
            "transfer_id": transfer_id
        }),
    )?;
    if nested {
        if let Some(object) = result.as_object_mut() {
            object.remove("snapshot");
            object.insert("snapshot_transfer_id".into(), json!(transfer_id));
        }
    } else {
        result = json!({"snapshot_transfer_id": transfer_id});
    }
    write_value(writer, &wire::response(request_id, result))
}

fn chunk_text(value: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        current.push(character);
        if current.len() >= max_chars {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn require_agent_id(command: &PublicCommand) -> Result<&str> {
    command
        .agent_id
        .as_deref()
        .or_else(|| command.params.get("agent_id").and_then(Value::as_str))
        .context("agent_id is required")
}

fn valid_preset_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

fn public_agent_value(agent: &AgentRecord) -> Value {
    let residency = match agent.status.as_str() {
        "inactive" => "inactive",
        "stopped" => "stopped",
        _ => "resident",
    };
    json!({
        "agent_id": agent.agent_id,
        "root_agent_id": agent.root_agent_id,
        "workspace_id": agent.workspace_id,
        "workspace_path": agent.workspace_path,
        "session_id": agent.session_id,
        "session_path": agent.session_path,
        "worker_id": agent.worker_id,
        "preset_id": agent.preset_id,
        "name": agent.name,
        "status": agent.status,
        "lifecycle": agent.lifecycle,
        "activity": if agent.status == "running" { "working" } else { "idle" },
        "residency": residency,
        "last_activity_at_ms": agent.last_activity_at_ms,
        "inactive_reason": agent.inactive_reason,
        "controller_client_id": agent.controller_client_id,
        "created_at_ms": agent.created_at_ms
    })
}

fn decorate_public_agent_runtime(value: &mut Value, worker: &WorkerConnection) {
    decorate_public_agent_descriptor(value, &worker.descriptor);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "generation".into(),
            json!(worker.generation.load(Ordering::SeqCst)),
        );
        object.insert(
            "status".into(),
            json!(
                worker
                    .status
                    .lock()
                    .expect("worker status mutex poisoned")
                    .clone()
            ),
        );
        object.insert("residency".into(), json!("resident"));
        object.insert("inactive_reason".into(), Value::Null);
    }
}

fn decorate_public_agent_descriptor(value: &mut Value, descriptor: &WorkerDescriptor) {
    if let Some(object) = value.as_object_mut() {
        object.insert("config_path".into(), json!(descriptor.config_path));
        object.insert("preset_id".into(), json!(descriptor.preset_id));
        object.insert(
            "repl_backend".into(),
            json!(descriptor.repl_backend.as_deref().unwrap_or("babashka")),
        );
    }
}

fn decorate_public_agent_summary(value: &mut Value, summary: &Value) {
    if let Some(object) = value.as_object_mut() {
        if let Some(lifecycle) = summary.get("lifecycle") {
            object.insert("lifecycle".into(), lifecycle.clone());
        }
        if let Some(activity) = summary.get("activity") {
            object.insert("activity".into(), activity.clone());
            object.insert(
                "status".into(),
                json!(if activity.as_str() == Some("working") {
                    "running"
                } else {
                    "idle"
                }),
            );
        }
        if let Some(last_activity) = summary.get("last_activity_at_ms") {
            object.insert("last_activity_at_ms".into(), last_activity.clone());
        }
    }
}

fn child_agent_value(descriptor: &WorkerDescriptor, generation: u64, child: &Value) -> Value {
    let agent_id = child
        .get("agent_id")
        .or_else(|| child.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    let resident = child
        .get("resident")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    json!({
        "agent_id": agent_id,
        "root_agent_id": descriptor.root_agent_id,
        "workspace_id": descriptor.workspace_id,
        "workspace_path": descriptor.workspace_path,
        "session_id": child.get("session-id").or_else(|| child.get("session_id")),
        "session_path": child.get("session-path").or_else(|| child.get("session_path")),
        "worker_id": descriptor.worker_id,
        "config_path": descriptor.config_path,
        "repl_backend": descriptor.repl_backend.as_deref().unwrap_or("babashka"),
        "generation": generation,
        "name": child.get("label"),
        "status": child.get("status"),
        "activity": if child.get("status").and_then(Value::as_str) == Some("running") { "working" } else { "idle" },
        "residency": if resident { "resident" } else { "inactive" },
        "controller_client_id": Value::Null,
        "created_at_ms": child.get("started-at").or_else(|| child.get("started_at")),
        "parent_agent_id": descriptor.root_agent_id,
        "is_child": true
    })
}

fn decorate_snapshot(
    descriptor: &WorkerDescriptor,
    generation: u64,
    agent_id: &str,
    sequence: u64,
    mut snapshot: Value,
) -> Value {
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("agent_id".into(), json!(agent_id));
        object.insert("root_agent_id".into(), json!(descriptor.root_agent_id));
        object.insert("worker_id".into(), json!(descriptor.worker_id));
        object.insert("generation".into(), json!(generation));
        object.insert(
            "cursor".into(),
            json!({"generation": generation, "sequence": sequence}),
        );
        object.entry("children").or_insert(json!([]));
    }
    snapshot
}

fn phase_from_snapshot(snapshot: &Value) -> String {
    snapshot
        .pointer("/state/phase")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_owned()
}

fn apply_session_summary(agent: &mut AgentRecord, summary: &Value) {
    if let Some(session_id) = summary.get("session_id").and_then(Value::as_str) {
        agent.session_id = Some(session_id.to_owned());
    }
    if let Some(lifecycle) = summary.get("lifecycle").and_then(Value::as_str) {
        agent.lifecycle = lifecycle.to_owned();
    }
    agent.last_activity_at_ms = summary
        .get("last_activity_at_ms")
        .and_then(Value::as_u64)
        .map(u128::from);
    agent.status = if summary.get("activity").and_then(Value::as_str) == Some("working") {
        "running".into()
    } else {
        "idle".into()
    };
    agent.inactive_reason = None;
}

fn doctor(runtime: &Runtime, fix: bool) -> Value {
    let purged_expired_leases = if fix {
        runtime.database.purge_expired_leases().unwrap_or(0)
    } else {
        0
    };
    let workers: Vec<_> = runtime
        .workers
        .lock()
        .expect("workers mutex poisoned")
        .values()
        .cloned()
        .collect();
    let values: Vec<_> = workers
        .iter()
        .map(|worker| {
            let log_path = runtime
                .paths
                .logs_dir
                .join(format!("worker-{}.log", worker.descriptor.worker_id));
            json!({
                "worker_id": worker.descriptor.worker_id,
                "agent_id": worker.descriptor.agent_id,
                "pid": worker.descriptor.pid,
                "child_pid": worker.descriptor.child_pid,
                "generation": worker.generation.load(Ordering::SeqCst),
                "status": worker.status.lock().expect("worker status mutex poisoned").clone(),
                "alive": worker.alive.load(Ordering::SeqCst),
                "socket": worker.descriptor.socket_path,
                "session": worker.descriptor.session_path,
                "attachments": worker.attachments.lock().expect("attachments mutex poisoned").len(),
                "buffered_events": worker.events.lock().expect("events mutex poisoned").len(),
                "log_tail": bounded_log_tail(&log_path, 8 * 1024),
            })
        })
        .collect();
    let database_integrity = runtime
        .database
        .integrity()
        .unwrap_or_else(|error| format!("error: {error:#}"));
    let schema_revision = runtime.database.schema_revision().unwrap_or(-1);
    let workers_ok = values
        .iter()
        .all(|worker| worker.get("alive") == Some(&Value::Bool(true)));
    let telemetry_sources = runtime.paths.telemetry_sources(
        runtime
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .map(|agent| agent.session_path.clone()),
    );
    json!({
        "ok": workers_ok && database_integrity == "ok"
            && schema_revision == SCHEMA_REVISION,
        "daemon_pid": std::process::id(),
        "schema_revision": schema_revision,
        "supported_schema_revision": SCHEMA_REVISION,
        "database_integrity": database_integrity,
        "socket": runtime.paths.public_socket,
        "database": runtime.paths.database,
        "database_backups": runtime.paths.state_dir.join("backups"),
        "telemetry_sources": telemetry_sources,
        "workers": values,
        "idle_eviction": idle_eviction_status(runtime),
        "schedules": runtime.database.list_schedules(None).unwrap_or_default(),
        "goals": runtime.database.list_goals(None).unwrap_or_default(),
        "quotas": {
            "max_workers": configured_max_workers(),
            "max_turn_bytes": 256 * 1024,
            "max_goal_continuations": 20,
            "workspace_write_roots": 1,
            "allowed_providers": configured_allowed_providers(),
            "max_tokens_per_run": configured_max_tokens_per_run(),
            "worker_cpu_seconds": env_var(
                "QI_AGENT_WORKER_CPU_SECONDS",
                "DAO_WORKER_CPU_SECONDS",
            ),
            "log_max_bytes": configured_log_max_bytes(),
            "log_backups": configured_log_backups(),
            "max_worker_logs": configured_max_worker_logs(),
        },
        "repair": {
            "requested": fix,
            "purged_expired_leases": purged_expired_leases,
            "destructive": false,
        }
    })
}

fn bounded_log_tail(path: &Path, max_bytes: usize) -> Value {
    let Ok(bytes) = fs::read(path) else {
        return Value::Null;
    };
    let start = bytes.len().saturating_sub(max_bytes);
    Value::String(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

fn process_alive(pid: Option<u32>) -> bool {
    pid.is_some_and(|pid| unsafe { libc::kill(pid as i32, 0) == 0 })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_ms_i64() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

fn normalize_session_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if absolute.exists() {
        return canonical(absolute);
    }
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(
            ancestor
                .file_name()
                .context("session path has no filename")?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .context("session path has no existing parent")?;
    }
    let mut resolved = canonical(ancestor)?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn reject_archive_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("session archive does not follow symbolic links")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OwnedWorkerProcess(std::process::Child);

    impl OwnedWorkerProcess {
        fn spawn() -> Self {
            let mut command = Command::new("/bin/sleep");
            command
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            let mut child = command.spawn().unwrap();
            assert!(child.try_wait().unwrap().is_none());
            Self(child)
        }

        fn stopped(&mut self) -> bool {
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                if self.0.try_wait().unwrap().is_some() {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    impl Drop for OwnedWorkerProcess {
        fn drop(&mut self) {
            if matches!(self.0.try_wait(), Ok(None)) {
                unsafe {
                    libc::kill(-(self.0.id() as i32), libc::SIGKILL);
                }
                let _ = self.0.wait();
            }
        }
    }

    fn assert_failed_start_cleanup(state: &str, remove_descriptor: bool) {
        let root = std::env::temp_dir().join(format!("qi-failed-start-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("worker.json");
        let socket = root.join("worker.sock");
        let mut proxy = OwnedWorkerProcess::spawn();
        let mut fallback = OwnedWorkerProcess::spawn();
        let mut child = OwnedWorkerProcess::spawn();
        let descriptor = WorkerDescriptor {
            version: 1,
            worker_id: "worker-test".into(),
            agent_id: "agent-test".into(),
            root_agent_id: "agent-test".into(),
            workspace_id: "workspace-test".into(),
            workspace_path: root.clone(),
            session_path: root.join("session.jsonl"),
            repository_root: root.clone(),
            config_path: root.join("agent.edn"),
            preset_id: None,
            repl_backend: None,
            socket_path: socket.clone(),
            token: "test-only".into(),
            generation: 1,
            pid: (state == "known-pid").then_some(proxy.0.id()),
            child_pid: (state == "child-group").then_some(child.0.id()),
            child_process_group: (state == "child-group").then_some(child.0.id()),
            owned_helpers: Vec::new(),
            session_id: None,
            status: "starting".into(),
            started_at_ms: 0,
        };
        if state != "missing" {
            write_descriptor(&path, &descriptor).unwrap();
            fs::write(&socket, b"owned socket placeholder").unwrap();
        }
        terminate_failed_worker_start(&path, remove_descriptor, Some(fallback.0.id()));
        let (proxy_stopped, fallback_stopped) = if state == "known-pid" {
            (proxy.stopped(), fallback.0.try_wait().unwrap().is_some())
        } else {
            (proxy.0.try_wait().unwrap().is_some(), fallback.stopped())
        };
        let child_stopped = if state == "child-group" {
            child.stopped()
        } else {
            child.0.try_wait().unwrap().is_some()
        };
        let descriptor_state = if !remove_descriptor && state != "missing" {
            let stopped = read_descriptor(&path).unwrap();
            stopped.status == "stopped" && stopped.pid.is_none() && stopped.child_pid.is_none()
        } else {
            !path.exists()
        };
        let socket_removed = !socket.exists();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            proxy_stopped,
            state == "known-pid",
            "recorded PID must take precedence"
        );
        assert_eq!(
            fallback_stopped,
            state != "known-pid",
            "fallback PID must terminate only when needed"
        );
        assert_eq!(
            child_stopped,
            state == "child-group",
            "recorded child group must also terminate"
        );
        assert!(
            descriptor_state,
            "descriptor removal/stopped state must persist"
        );
        assert!(socket_removed, "failed worker socket must be removed");
    }

    #[test]
    fn failed_start_cleans_new_worker_without_recorded_pid() {
        assert_failed_start_cleanup("no-pid", true);
    }

    #[test]
    fn failed_start_cleans_recovery_without_recorded_pid() {
        assert_failed_start_cleanup("no-pid", false);
    }

    #[test]
    fn failed_start_preserves_recorded_pid_precedence() {
        for remove in [true, false] {
            assert_failed_start_cleanup("known-pid", remove);
        }
    }

    #[test]
    fn failed_start_cleans_missing_descriptor() {
        for remove in [true, false] {
            assert_failed_start_cleanup("missing", remove);
        }
    }

    #[test]
    fn failed_start_cleans_child_group_and_fallback_proxy() {
        for remove in [true, false] {
            assert_failed_start_cleanup("child-group", remove);
        }
    }

    #[test]
    fn database_migrations_are_versioned_backed_up_and_reject_newer_schemas() {
        let root = std::env::temp_dir().join(format!("qi-agent-migration-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("supervisor.sqlite");
        let database = Database::new(path.clone()).unwrap();
        assert_eq!(database.schema_revision().unwrap(), SCHEMA_REVISION);
        assert_eq!(database.integrity().unwrap(), "ok");

        database
            .connection()
            .unwrap()
            .pragma_update(None, "user_version", 1)
            .unwrap();
        let migrated = Database::new(path.clone()).unwrap();
        assert_eq!(migrated.schema_revision().unwrap(), SCHEMA_REVISION);
        let backup_dir = root.join("backups");
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), 1);

        for _ in 0..7 {
            let backup = migrated.backup("manual").unwrap();
            assert_eq!(
                Connection::open(backup)
                    .unwrap()
                    .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
        assert_eq!(
            fs::read_dir(&backup_dir).unwrap().count(),
            DATABASE_BACKUPS_TO_KEEP
        );

        let newer_path = root.join("newer.sqlite");
        let connection = Connection::open(&newer_path).unwrap();
        connection
            .pragma_update(None, "user_version", SCHEMA_REVISION + 1)
            .unwrap();
        drop(connection);
        let error = Database::new(newer_path).err().unwrap();
        assert!(error.to_string().contains("newer than supported"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_logs_rotate_with_a_bounded_history() {
        let root = std::env::temp_dir().join(format!("qi-agent-log-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let log = root.join("worker-1.log");
        fs::write(&log, b"first").unwrap();
        assert!(rotate_log_if_needed(&log, 1, 3).unwrap());
        fs::write(&log, b"second").unwrap();
        assert!(rotate_log_if_needed(&log, 1, 3).unwrap());
        assert_eq!(fs::read(log.with_extension("log.1")).unwrap(), b"second");
        assert_eq!(fs::read(log.with_extension("log.2")).unwrap(), b"first");
        assert!(!log.with_extension("log.4").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_journal_replays_completed_outcome_and_rejects_conflicts() {
        let root = std::env::temp_dir().join(format!("qi-agent-db-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let command = PublicCommand {
            version: 1,
            kind: "command".into(),
            request_id: "request-1".into(),
            client_id: "client-1".into(),
            journal_id: None,
            command_id: Some("command-1".into()),
            agent_id: Some("agent-1".into()),
            method: "turn.submit".into(),
            params: json!({"message": "hello"}),
        };
        assert!(matches!(
            database.begin_command(&command).unwrap(),
            JournalEntry::New
        ));
        database
            .finish_command(
                "client-1",
                "command-1",
                "completed",
                &json!({"accepted": true}),
            )
            .unwrap();
        match database.begin_command(&command).unwrap() {
            JournalEntry::Completed(value) => assert_eq!(value, json!({"accepted": true})),
            _ => panic!("expected completed journal outcome"),
        }
        assert_eq!(
            database.command_status("client-1", "command-1").unwrap()["status"],
            "completed"
        );
        assert_eq!(
            database
                .command_status("another-client", "command-1")
                .unwrap()["status"],
            "not_found"
        );
        let mut reconnected = command.clone();
        reconnected.client_id = "new-socket-client".into();
        reconnected.journal_id = Some("client-1".into());
        assert!(matches!(
            database.begin_command(&reconnected).unwrap(),
            JournalEntry::Completed(_)
        ));
        let mut another_agent = command.clone();
        another_agent.agent_id = Some("different-agent".into());
        assert!(database.begin_command(&another_agent).is_err());
        let mut conflict = command;
        conflict.params = json!({"message": "different"});
        assert!(database.begin_command(&conflict).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_cursor_is_generation_aware() {
        let descriptor = WorkerDescriptor {
            version: 1,
            worker_id: "worker-1".into(),
            agent_id: "agent-1".into(),
            root_agent_id: "agent-1".into(),
            workspace_id: "workspace-1".into(),
            workspace_path: PathBuf::from("/workspace"),
            session_path: PathBuf::from("/workspace/session.jsonl"),
            repository_root: PathBuf::from("/repo"),
            config_path: PathBuf::from("/repo/agent.edn"),
            preset_id: None,
            repl_backend: None,
            socket_path: PathBuf::from("/tmp/worker.sock"),
            token: "secret".into(),
            generation: 4,
            pid: None,
            child_pid: None,
            child_process_group: None,
            owned_helpers: Vec::new(),
            session_id: Some("session-1".into()),
            status: "running".into(),
            started_at_ms: 0,
        };
        let snapshot = decorate_snapshot(
            &descriptor,
            descriptor.generation,
            "agent-1",
            19,
            json!({"cursor": 7, "events": []}),
        );
        assert_eq!(snapshot.pointer("/cursor/generation"), Some(&json!(4)));
        assert_eq!(snapshot.pointer("/cursor/sequence"), Some(&json!(19)));
    }

    #[test]
    fn stale_goal_continuation_cannot_duplicate_a_newly_resumed_run() {
        let root = std::env::temp_dir().join(format!("qi-goal-admission-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let goal = database
            .create_goal("agent-1", "first objective", 3)
            .unwrap();
        let id = goal["goal_id"].as_str().unwrap();
        database.record_goal_run(id, "first-run").unwrap();
        let queued = database.finish_goal_run("first-run").unwrap().unwrap();
        assert!(
            current_goal_continuation(&database, &queued)
                .unwrap()
                .is_some()
        );
        let current = database.list_goals(Some("agent-1")).unwrap().remove(0);
        database
            .revise_goal(
                id,
                current["revision"].as_i64().unwrap(),
                "updated objective",
                3,
                "active",
            )
            .unwrap();
        assert_eq!(
            current_goal_continuation(&database, &queued)
                .unwrap()
                .unwrap()["objective"],
            "updated objective"
        );
        database.record_goal_run(id, "resumed-run").unwrap();
        assert!(
            current_goal_continuation(&database, &queued)
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn typed_turn_validation_bounds_refs_without_accepting_inline_data_or_paths() {
        let attachment = json!({"type":"attachment","id":"asset_01234567","name":"示例.png","mime":"image/png","size":68,"workspaceId":"1234567890abcdef"});
        assert!(
            validate_turn_message(&json!([{"type":"text","text":"inspect"}, attachment])).is_ok()
        );
        assert!(validate_turn_message(&json!([attachment])).is_ok());
        assert!(validate_turn_message(&json!([])).is_err());
        assert!(validate_turn_message(&json!([{"type":"text","text":""}])).is_err());
        assert!(validate_turn_message(&json!([{"type":"image","data":"base64"}])).is_err());
        let mut traversal = attachment.clone();
        traversal["id"] = json!("../../secret");
        assert!(validate_turn_message(&json!([traversal])).is_err());
        let mut oversized = attachment;
        oversized["size"] = json!(8_388_609);
        assert!(validate_turn_message(&json!([oversized])).is_err());
        assert!(
            validate_turn_message(&json!([{"type":"text","text":"x".repeat(256*1024)}])).is_err()
        );
    }

    #[test]
    fn calendar_cron_supports_timezones_calendar_fields_and_dst() {
        let stamp = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(
            next_schedule_time_in_zone(
                "0 9 * * MON-FRI",
                stamp("2026-10-02T02:00:00Z"),
                "Asia/Hong_Kong"
            ),
            Some(stamp("2026-10-05T01:00:00Z"))
        );
        assert_eq!(
            next_schedule_time("*/7 * * * *", stamp("2026-10-02T10:58:00Z")),
            Some(stamp("2026-10-02T11:00:00Z"))
        );
        assert_eq!(
            next_schedule_time("0 9 29 FEB *", stamp("2026-01-01T00:00:00Z")),
            Some(stamp("2028-02-29T09:00:00Z"))
        );
        assert_eq!(
            next_schedule_time("0 9 31 FEB *", stamp("2026-01-01T00:00:00Z")),
            None
        );
        // Standard cron uses OR when day-of-month and day-of-week are restricted.
        assert_eq!(
            next_schedule_time("0 9 1 * MON", stamp("2026-10-02T00:00:00Z")),
            Some(stamp("2026-10-05T09:00:00Z"))
        );
        // 02:30 is missing at spring-forward; 01:30 occurs twice at fall-back.
        assert_eq!(
            next_schedule_time_in_zone(
                "30 2 * * *",
                stamp("2026-03-08T06:59:00Z"),
                "America/New_York"
            ),
            Some(stamp("2026-03-09T06:30:00Z"))
        );
        assert_eq!(
            next_schedule_time_in_zone(
                "30 1 * * *",
                stamp("2026-11-01T05:29:00Z"),
                "America/New_York"
            ),
            Some(stamp("2026-11-01T05:30:00Z"))
        );
        assert_eq!(
            next_schedule_time_in_zone(
                "30 1 * * *",
                stamp("2026-11-01T05:30:00Z"),
                "America/New_York"
            ),
            Some(stamp("2026-11-02T06:30:00Z"))
        );
        assert_eq!(
            next_schedule_time_in_zone("0 9 * * *", 0, "Mars/Unknown"),
            None
        );
        assert!(schedule_spec(&json!({"daily":"09:00","timezone":"Asia/Hong_Kong"})).is_ok());
        assert!(schedule_spec(&json!({"weekly":"MON,WED 09:00"})).is_ok());
        assert!(schedule_spec(&json!({"daily":"09:00","every_ms":1000})).is_err());
        assert!(schedule_spec(&json!({"daily":"24:00"})).is_err());
    }

    #[test]
    fn schedule_revision_pause_recovery_and_unknown_delivery_are_fenced() {
        let root = std::env::temp_dir().join(format!("qi-automation-cas-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let call = |method: &str, p: Value| automation_operation(&database, "agent-1", method, &p);
        let added = call(
            "schedule.add",
            json!({"daily":"09:00","timezone":"Asia/Hong_Kong","prompt":"check"}),
        )
        .unwrap();
        let id = added["schedule_id"].as_str().unwrap();
        let paused = call(
            "schedule.pause",
            json!({"schedule_id":id,"expected_revision":1}),
        )
        .unwrap();
        assert_eq!(paused["status"], "paused");
        assert_eq!(paused["revision"], 2);
        assert!(
            call(
                "schedule.update",
                json!({"schedule_id":id,"expected_revision":1,"prompt":"stale"})
            )
            .is_err()
        );
        let reopened = Database::new(root.join("supervisor.sqlite")).unwrap();
        assert_eq!(
            reopened.list_schedules(Some("agent-1")).unwrap()[0]["status"],
            "paused"
        );
        let resumed = call(
            "schedule.resume",
            json!({"schedule_id":id,"expected_revision":2}),
        )
        .unwrap();
        assert_eq!(resumed["status"], "active");
        assert_eq!(resumed["policy"]["timezone"], "Asia/Hong_Kong");
        let due = database
            .add_schedule("agent-1", "@every 1000ms", 0, &json!({"prompt":"due"}))
            .unwrap();
        let claim = database.claim_due_schedule().unwrap().unwrap();
        let claimed = call(
            "schedule.cancel",
            json!({"schedule_id":due["schedule_id"],"expected_revision":2}),
        )
        .unwrap();
        assert_eq!(claimed["status"], "cancelled");
        finish_schedule_dispatch(&database, &claim, Ok(json!({})));
        assert_eq!(
            database
                .list_schedules(Some("agent-1"))
                .unwrap()
                .iter()
                .find(|row| row["schedule_id"] == due["schedule_id"])
                .unwrap()["status"],
            "cancelled"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn goals_require_explicit_revisions_budget_and_reconciliation() {
        let root = std::env::temp_dir().join(format!("qi-goal-cas-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let call = |method: &str, p: Value| automation_operation(&database, "agent-1", method, &p);
        let goal = call(
            "goal.set",
            json!({"objective":"finish", "max_continuations":1}),
        )
        .unwrap();
        let id = goal["goal_id"].as_str().unwrap();
        assert!(call("goal.set", json!({"objective":"replace"})).is_err());
        let paused = call("goal.pause", json!({"goal_id":id,"expected_revision":1})).unwrap();
        assert_eq!(paused["status"], "paused");
        database.mark_goal_error(id, "late failure").unwrap();
        assert_eq!(
            call("goal.status", json!({"goal_id":id})).unwrap()["status"],
            "paused"
        );
        assert!(
            call(
                "goal.update",
                json!({"goal_id":id,"expected_revision":1,"objective":"stale"})
            )
            .is_err()
        );
        database
            .mark_interrupted_agent_work_uncertain("agent-1")
            .unwrap();
        let uncertain = call("goal.status", json!({"goal_id":id})).unwrap();
        assert_eq!(uncertain["status"], "uncertain");
        assert!(
            call(
                "goal.resume",
                json!({"goal_id":id,"expected_revision":uncertain["revision"]})
            )
            .is_err()
        );
        let active = call(
            "goal.resume",
            json!({"goal_id":id,"expected_revision":uncertain["revision"],"reconciled":true}),
        )
        .unwrap();
        assert_eq!(active["status"], "active");
        assert!(
            automation_operation(
                &database,
                "observer-agent",
                "goal.cancel",
                &json!({"goal_id":id})
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schedule_parser_supports_one_shot_every_and_minute_cron() {
        let now = 1_700_000_000_123i64;
        assert_eq!(next_schedule_time("at:1700000001000", now), None);
        assert_eq!(next_schedule_time("@every 500ms", now), Some(now + 500));
        let every_minute = next_schedule_time("* * * * *", now).unwrap();
        assert!(every_minute > now);
        assert_eq!(every_minute % 60_000, 0);
        let every_five = next_schedule_time("*/5 * * * *", now).unwrap();
        assert_eq!(every_five.div_euclid(60_000).rem_euclid(5), 0);
        assert_eq!(next_schedule_time("bad cron", now), None);
    }

    #[test]
    fn idle_sweep_interval_matches_lifecycle_policy() {
        assert_eq!(
            idle_sweep_interval(Some(Duration::from_secs(90 * 60))),
            Duration::from_secs(5 * 60)
        );
        assert_eq!(
            idle_sweep_interval(Some(Duration::from_secs(6 * 60))),
            Duration::from_secs(2 * 60)
        );
        assert_eq!(
            idle_sweep_interval(Some(Duration::from_secs(60))),
            Duration::from_secs(60)
        );
        assert_eq!(idle_sweep_interval(None), Duration::from_secs(5 * 60));
    }

    #[test]
    fn idle_session_predicate_fails_closed_and_honors_threshold_equality() {
        let now = 10_000u128;
        let mut newest = None;
        let mut pins = Vec::new();
        inspect_session_idle(
            &json!({"activity": "idle", "last_activity_at_ms": 9_000}),
            "agent-1",
            now,
            1_000,
            &mut newest,
            &mut pins,
        );
        assert!(pins.is_empty());
        assert_eq!(newest, Some(9_000));

        inspect_session_idle(
            &json!({"activity": "idle"}),
            "agent-2",
            now,
            1_000,
            &mut newest,
            &mut pins,
        );
        assert_eq!(pins, vec!["invalid-activity-time:agent-2"]);
    }

    #[test]
    fn interrupted_schedule_tick_is_not_replayed() {
        let root = std::env::temp_dir().join(format!("qi-agent-schedule-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let one_shot = database
            .add_schedule(
                "agent-1",
                &format!("at:{}", now_ms_i64() - 1),
                now_ms_i64() - 1,
                &json!({"prompt": "once"}),
            )
            .unwrap();
        let claim = database.claim_due_schedule().unwrap().unwrap();
        assert_eq!(
            claim.schedule_id,
            one_shot.get("schedule_id").unwrap().as_str().unwrap()
        );
        assert_eq!(database.recover_claimed_schedules().unwrap(), 1);
        let schedules = database.list_schedules(Some("agent-1")).unwrap();
        assert_eq!(schedules[0].get("status"), Some(&json!("uncertain")));
        assert!(schedules[0].get("claim").unwrap().is_null());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncertain_schedule_delivery_keeps_its_identity_and_never_retries() {
        let root = std::env::temp_dir().join(format!("qi-schedule-uncertain-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let (stream, _peer) = UnixStream::pair().unwrap();
        let paths = RuntimePaths {
            runtime_dir: root.clone(),
            state_dir: root.clone(),
            public_socket: root.join("public.sock"),
            daemon_lock: root.join("daemon.lock"),
            database: root.join("supervisor.sqlite"),
            workers_dir: root.clone(),
            logs_dir: root.clone(),
            client_id: root.join("client-id"),
        };
        let worker = WorkerConnection {
            descriptor: WorkerDescriptor::new(
                &paths,
                "worker-test".into(),
                "agent-1".into(),
                "workspace-1".into(),
                root.clone(),
                root.join("session.jsonl"),
                root.clone(),
                root.join("agent.edn"),
                "test".into(),
            ),
            writer: Mutex::new(BufWriter::new(stream)),
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(VecDeque::new()),
            attachments: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            generation: AtomicU64::new(1),
            status: Mutex::new("idle".into()),
            alive: AtomicBool::new(true),
            lifecycle: Mutex::new(()),
        };
        let timeout = worker
            .call(
                "turn.submit",
                json!({"message":"accepted but acknowledgement lost"}),
                Duration::from_millis(10),
            )
            .unwrap_err()
            .to_string();
        assert!(worker.pending.lock().unwrap().is_empty());
        for message in [
            timeout.as_str(),
            "worker exited before the RPC outcome was durable; outcome is uncertain",
            "worker RPC turn.submit write failed; outcome is uncertain",
        ] {
            database
                .add_schedule(
                    "agent-1",
                    "@every 100ms",
                    now_ms_i64() - 1,
                    &json!({"prompt":"once","max_attempts":3}),
                )
                .unwrap();
            let claim = database.claim_due_schedule().unwrap().unwrap();
            finish_schedule_dispatch(&database, &claim, Err(anyhow!("{message}")));
            assert!(database.claim_due_schedule().unwrap().is_none());
            let schedule = database
                .list_schedules(None)
                .unwrap()
                .into_iter()
                .find(|row| row["schedule_id"] == claim.schedule_id)
                .unwrap();
            assert_eq!(schedule["status"], "uncertain");
            assert_eq!(schedule["policy"]["delivery_id"], claim.delivery_id);
            assert!(schedule["next_at_ms"].is_null());
        }
        // A restart in the claim/dispatch gap must pause a periodic tick too.
        database
            .add_schedule(
                "agent-1",
                "@every 100ms",
                now_ms_i64() - 1,
                &json!({"prompt":"periodic"}),
            )
            .unwrap();
        let claim = database.claim_due_schedule().unwrap().unwrap();
        assert_eq!(database.recover_claimed_schedules().unwrap(), 1);
        assert!(database.claim_due_schedule().unwrap().is_none());
        let schedule = database
            .list_schedules(None)
            .unwrap()
            .into_iter()
            .find(|row| row["schedule_id"] == claim.schedule_id)
            .unwrap();
        assert_eq!(schedule["policy"]["delivery_id"], claim.delivery_id);
        assert_eq!(schedule["status"], "uncertain");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn safe_schedule_retry_reuses_delivery_id_and_next_tick_gets_a_new_one() {
        let root = std::env::temp_dir().join(format!("qi-schedule-retry-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        database
            .add_schedule(
                "agent-1",
                "@every 100ms",
                now_ms_i64() - 1,
                &json!({"prompt":"tick"}),
            )
            .unwrap();
        let first = database.claim_due_schedule().unwrap().unwrap();
        finish_schedule_dispatch(
            &database,
            &first,
            Err(anyhow!("workspace write lease is held by another root")),
        );
        database
            .connection()
            .unwrap()
            .execute("UPDATE schedules SET next_at_ms=0", [])
            .unwrap();
        let retry = database.claim_due_schedule().unwrap().unwrap();
        assert_eq!(retry.delivery_id, first.delivery_id);
        assert_ne!(retry.claim, first.claim);
        finish_schedule_dispatch(
            &database,
            &retry,
            Ok(json!({"accepted":true,"request_id":retry.delivery_id})),
        );
        database
            .connection()
            .unwrap()
            .execute("UPDATE schedules SET next_at_ms=0", [])
            .unwrap();
        let next = database.claim_due_schedule().unwrap().unwrap();
        assert_ne!(next.delivery_id, first.delivery_id);
        assert_eq!(next.policy["last_delivery_id"], first.delivery_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncertain_lease_cannot_be_replaced_or_released_by_an_unrelated_run() {
        let root = std::env::temp_dir().join(format!("qi-uncertain-lease-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        database
            .acquire_workspace_lease("workspace", "root")
            .unwrap();
        database
            .retain_uncertain_workspace_lease("workspace", "root", Some("request-A"))
            .unwrap();
        assert!(
            database
                .acquire_workspace_lease("workspace", "root")
                .is_err()
        );
        assert!(
            database
                .acquire_workspace_lease("workspace", "other-root")
                .is_err()
        );
        assert_eq!(database.purge_expired_leases().unwrap(), 0);
        database
            .release_workspace_lease_after_run("workspace", "root", "request-B")
            .unwrap();
        assert!(
            database
                .acquire_workspace_lease("workspace", "other-root")
                .is_err()
        );
        database
            .release_workspace_lease_after_run("workspace", "root", "request-A")
            .unwrap();
        database
            .acquire_workspace_lease("workspace", "other-root")
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_chunks_preserve_unicode_boundaries() {
        let chunks = chunk_text("abc会话def", 4);
        assert_eq!(chunks.concat(), "abc会话def");
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.is_char_boundary(chunk.len()))
        );
    }

    #[test]
    fn slow_attachment_is_dropped_without_blocking_healthy_attachment() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let descriptor = WorkerDescriptor {
            version: 1,
            worker_id: "worker-1".into(),
            agent_id: "agent-1".into(),
            root_agent_id: "agent-1".into(),
            workspace_id: "workspace-1".into(),
            workspace_path: PathBuf::from("/workspace"),
            session_path: PathBuf::from("/workspace/session.jsonl"),
            repository_root: PathBuf::from("/repo"),
            config_path: PathBuf::from("/repo/agent.edn"),
            preset_id: None,
            repl_backend: None,
            socket_path: PathBuf::from("/tmp/worker.sock"),
            token: "secret".into(),
            generation: 1,
            pid: None,
            child_pid: None,
            child_process_group: None,
            owned_helpers: Vec::new(),
            session_id: None,
            status: "running".into(),
            started_at_ms: 0,
        };
        let worker = WorkerConnection {
            descriptor,
            writer: Mutex::new(BufWriter::new(stream)),
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(VecDeque::new()),
            attachments: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            generation: AtomicU64::new(1),
            status: Mutex::new("idle".into()),
            alive: AtomicBool::new(true),
            lifecycle: Mutex::new(()),
        };
        let (slow_tx, _slow_rx) = mpsc::sync_channel(1);
        let (fast_tx, fast_rx) = mpsc::sync_channel(2);
        worker.attach_at_sequence("slow".into(), "agent-1".into(), slow_tx);
        worker.attach_at_sequence("fast".into(), "agent-1".into(), fast_tx);
        worker.broadcast(json!({"agent_id": "agent-1", "event": 1}));
        assert_eq!(
            fast_rx.recv().unwrap(),
            json!({"agent_id": "agent-1", "event": 1})
        );
        worker.broadcast(json!({"agent_id": "agent-1", "event": 2}));
        assert_eq!(
            fast_rx.recv().unwrap(),
            json!({"agent_id": "agent-1", "event": 2})
        );
        worker.broadcast(json!({"agent_id": "agent-1", "event": 3}));
        assert_eq!(
            fast_rx.recv().unwrap(),
            json!({"agent_id": "agent-1", "event": 3})
        );
        let attachments = worker.attachments.lock().unwrap();
        assert!(!attachments.contains_key("slow"));
        assert!(attachments.contains_key("fast"));
    }
}
