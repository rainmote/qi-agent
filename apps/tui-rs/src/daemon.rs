use crate::{
    paths::{RuntimePaths, canonical, discover_repository_root, set_owner_only_file},
    wire::{self, PROTOCOL_VERSION, PublicCommand},
    worker_proxy::{WorkerDescriptor, read_descriptor, write_descriptor},
};
use anyhow::{Context, Result, anyhow, bail};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    os::unix::{
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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const PUBLIC_EVENT_BUFFER_LIMIT: usize = 2_000;
const ATTACHMENT_QUEUE_LIMIT: usize = 256;
const SNAPSHOT_INLINE_LIMIT: usize = 256 * 1024;
const SNAPSHOT_CHUNK_CHARS: usize = 64 * 1024;
const WORKER_RPC_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct AgentRecord {
    agent_id: String,
    root_agent_id: String,
    workspace_id: String,
    workspace_path: PathBuf,
    session_id: Option<String>,
    session_path: PathBuf,
    worker_id: String,
    name: Option<String>,
    status: String,
    controller_client_id: Option<String>,
    created_at_ms: u128,
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
}

impl WorkerConnection {
    fn call(&self, method: &str, parameters: Value, timeout: Duration) -> Result<Value> {
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
            return Err(error);
        }
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
    shutdown: AtomicBool,
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
}

#[derive(Clone, Debug)]
struct GoalContinuation {
    goal_id: String,
    agent_id: String,
    objective: String,
    continuation_count: u64,
    max_continuations: u64,
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
        Ok(connection)
    }

    fn initialize(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = self.connection()?;
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
              name TEXT,
              status TEXT NOT NULL,
              controller_client_id TEXT,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
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
            CREATE INDEX IF NOT EXISTS agents_workspace_idx ON agents(workspace_id);
            CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id);
            CREATE INDEX IF NOT EXISTS goals_agent_idx ON goals(agent_id,status);
            CREATE INDEX IF NOT EXISTS messages_target_idx
              ON messages(to_agent_id,status);
            ",
        )?;
        set_owner_only_file(&self.path)?;
        Ok(())
    }

    fn upsert_agent(&self, agent: &AgentRecord) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO agents
             (agent_id, root_agent_id, workspace_id, workspace_path, session_id,
              session_path, worker_id, name, status, controller_client_id,
              created_at_ms, updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(agent_id) DO UPDATE SET
              session_id=excluded.session_id, status=excluded.status,
              controller_client_id=excluded.controller_client_id,
              updated_at_ms=excluded.updated_at_ms",
            params![
                agent.agent_id,
                agent.root_agent_id,
                agent.workspace_id,
                agent.workspace_path.to_string_lossy(),
                agent.session_id,
                agent.session_path.to_string_lossy(),
                agent.worker_id,
                agent.name,
                agent.status,
                agent.controller_client_id,
                i64::try_from(agent.created_at_ms).unwrap_or(i64::MAX),
                now_ms_i64(),
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

    fn load_agents(&self) -> Result<Vec<AgentRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT agent_id,root_agent_id,workspace_id,workspace_path,session_id,
             session_path,worker_id,name,status,controller_client_id,created_at_ms
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
                name: row.get(7)?,
                status: row.get(8)?,
                controller_client_id: row.get(9)?,
                created_at_ms: row.get::<_, i64>(10)?.max(0) as u128,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
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
                command.client_id,
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
        let existing: (String, Option<String>, String, String) = connection.query_row(
            "SELECT status,outcome_json,method,params_json FROM commands
             WHERE client_id=?1 AND command_id=?2",
            params![command.client_id, command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if existing.2 != command.method || existing.3 != serde_json::to_string(&command.params)? {
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
                    "SELECT owner FROM leases
                     WHERE resource_type='workspace-write' AND resource_key=?1",
                    params![workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if current.as_deref().is_some_and(|value| value != owner) {
                bail!("workspace write lease is held by {}", current.unwrap())
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
            let next = next_schedule_time(&expression, now_ms_i64());
            let status = if next.is_some() {
                "active"
            } else {
                "uncertain"
            };
            recovered += connection.execute(
                "UPDATE schedules SET status=?2,next_at_ms=?3,claim=NULL,policy_json=?4
                 WHERE schedule_id=?1 AND status='claimed'",
                params![schedule_id, status, next, serde_json::to_string(&policy)?],
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
            "status": "active"
        }))
    }

    fn list_schedules(&self, agent_id: Option<&str>) -> Result<Vec<Value>> {
        let connection = self.connection()?;
        let sql = if agent_id.is_some() {
            "SELECT schedule_id,agent_id,expression,next_at_ms,claim,policy_json,status
             FROM schedules WHERE agent_id=?1 ORDER BY next_at_ms"
        } else {
            "SELECT schedule_id,agent_id,expression,next_at_ms,claim,policy_json,status
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
            }))
        };
        let rows = if let Some(agent_id) = agent_id {
            statement.query_map(params![agent_id], map_row)?
        } else {
            statement.query_map([], map_row)?
        };
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn cancel_schedule(&self, schedule_id: &str) -> Result<bool> {
        Ok(self.connection()?.execute(
            "UPDATE schedules SET status='cancelled',claim=NULL,next_at_ms=NULL
             WHERE schedule_id=?1 AND status IN ('active','claimed')",
            params![schedule_id],
        )? > 0)
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
        let updated = connection.execute(
            "UPDATE schedules SET status='claimed',claim=?2
             WHERE schedule_id=?1 AND status='active'",
            params![schedule_id, claim],
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
            policy: serde_json::from_str(&policy_text).unwrap_or(Value::Null),
            claim,
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
            "UPDATE schedules SET status=?3,next_at_ms=?4,policy_json=?5,claim=NULL
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
        connection.execute(
            "UPDATE goals SET status='superseded',updated_at_ms=?2
             WHERE agent_id=?1 AND status='active'",
            params![agent_id, now_ms_i64()],
        )?;
        let goal_id = format!("goal-{}", Uuid::new_v4());
        connection.execute(
            "INSERT INTO goals
             (goal_id,agent_id,objective,status,continuation_count,max_continuations,
              created_at_ms,updated_at_ms)
             VALUES (?1,?2,?3,'active',0,?4,?5,?5)",
            params![goal_id, agent_id, objective, max as i64, now_ms_i64()],
        )?;
        Ok(json!({
            "goal_id": goal_id,
            "agent_id": agent_id,
            "objective": objective,
            "status": "active",
            "continuation_count": 0,
            "max_continuations": max,
        }))
    }

    fn list_goals(&self, agent_id: Option<&str>) -> Result<Vec<Value>> {
        let connection = self.connection()?;
        let sql = if agent_id.is_some() {
            "SELECT goal_id,agent_id,objective,status,continuation_count,
                    max_continuations,last_request_id,last_error,created_at_ms,updated_at_ms
             FROM goals WHERE agent_id=?1 ORDER BY created_at_ms DESC"
        } else {
            "SELECT goal_id,agent_id,objective,status,continuation_count,
                    max_continuations,last_request_id,last_error,created_at_ms,updated_at_ms
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
            }))
        };
        let rows = if let Some(agent_id) = agent_id {
            statement.query_map(params![agent_id], map_row)?
        } else {
            statement.query_map([], map_row)?
        };
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn set_goal_status(&self, goal_id: &str, status: &str) -> Result<bool> {
        Ok(self.connection()?.execute(
            "UPDATE goals SET status=?2,updated_at_ms=?3 WHERE goal_id=?1",
            params![goal_id, status, now_ms_i64()],
        )? > 0)
    }

    fn record_goal_run(&self, goal_id: &str, request_id: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO goal_runs(request_id,goal_id,status,created_at_ms)
             VALUES (?1,?2,'running',?3)",
            params![request_id, goal_id, now_ms_i64()],
        )?;
        connection.execute(
            "UPDATE goals SET last_request_id=?2,updated_at_ms=?3 WHERE goal_id=?1",
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
                "UPDATE goals SET status='budget_exhausted',updated_at_ms=?2
                 WHERE goal_id=?1",
                params![goal_id, now_ms_i64()],
            )?;
            None
        } else {
            let next = count + 1;
            connection.execute(
                "UPDATE goals SET continuation_count=?2,updated_at_ms=?3 WHERE goal_id=?1",
                params![goal_id, next as i64, now_ms_i64()],
            )?;
            Some(GoalContinuation {
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
            "UPDATE goals SET status='blocked',last_error=?2,updated_at_ms=?3
             WHERE goal_id=?1",
            params![goal_id, error, now_ms_i64()],
        )?;
        Ok(())
    }

    fn record_task(&self, agent_id: &str, request_id: &str) -> Result<String> {
        let task_id = format!("task-{}", Uuid::new_v4());
        self.connection()?.execute(
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
                   updated_at_ms=?2
                 WHERE agent_id=?1 AND status='active'",
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

pub fn serve(repository_root: Option<&Path>, config_path: Option<&Path>) -> Result<()> {
    let paths = RuntimePaths::discover()?;
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
        .context("another dao daemon already owns the launch lease")?;
    if UnixStream::connect(&paths.public_socket).is_ok() {
        bail!("dao daemon is already running")
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
        shutdown: AtomicBool::new(false),
    });
    runtime.restore_agents()?;
    runtime.adopt_workers();
    runtime.recover_missing_workers();
    spawn_scheduler(Arc::clone(&runtime));

    while !runtime.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                let runtime = Arc::clone(&runtime);
                thread::spawn(move || {
                    if let Err(error) = handle_client(runtime, stream) {
                        eprintln!("dao client connection failed: {error:#}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error).context("daemon socket accept failed"),
        }
    }

    runtime.stop_all_workers();
    let _ = fs::remove_file(&paths.public_socket);
    drop(lock_file);
    Ok(())
}

impl Runtime {
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
            if self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .contains_key(&descriptor.worker_id)
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
                if let Some(agent) = self
                    .agents
                    .lock()
                    .expect("agents mutex poisoned")
                    .get_mut(&descriptor.agent_id)
                {
                    agent.status = "idle".into();
                    agent.session_id = descriptor.session_id.clone();
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
            .keys()
            .cloned()
            .collect();
        let agents: Vec<_> = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .filter(|agent| {
                !active_worker_ids.contains(&agent.worker_id) && agent.status != "stopped"
            })
            .cloned()
            .collect();
        for agent in agents {
            let descriptor_path = self.paths.worker_descriptor(&agent.worker_id);
            let Ok(mut descriptor) = read_descriptor(&descriptor_path) else {
                continue;
            };
            if process_alive(descriptor.pid) {
                continue;
            }
            let _ = self
                .database
                .mark_interrupted_agent_work_uncertain(&agent.agent_id);
            descriptor.generation = descriptor.generation.saturating_add(1);
            descriptor.pid = None;
            descriptor.child_pid = None;
            descriptor.status = "starting".into();
            if write_descriptor(&descriptor_path, &descriptor).is_err()
                || spawn_worker_proxy(&descriptor_path).is_err()
            {
                continue;
            }
            let Ok(connected_descriptor) =
                wait_for_worker(&descriptor_path, Duration::from_secs(20))
            else {
                continue;
            };
            let Ok(worker) = connect_worker(connected_descriptor.clone(), self.database.clone())
            else {
                continue;
            };
            let _ = self
                .database
                .upsert_worker(&connected_descriptor, &descriptor_path);
            self.workers
                .lock()
                .expect("workers mutex poisoned")
                .insert(agent.worker_id.clone(), worker);
            if let Some(current) = self
                .agents
                .lock()
                .expect("agents mutex poisoned")
                .get_mut(&agent.agent_id)
            {
                current.status = "idle".into();
                current.session_id = connected_descriptor.session_id;
                let _ = self.database.upsert_agent(current);
            }
        }
    }

    fn create_agent(self: &Arc<Self>, parameters: &Value) -> Result<Value> {
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
                    ".bb-agent/sessions/{}-{}.jsonl",
                    now_ms(),
                    &Uuid::new_v4().to_string()[..8]
                ))
            };
        if let Some(parent) = session_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
        let descriptor = WorkerDescriptor::new(
            &self.paths,
            worker_id.clone(),
            agent_id.clone(),
            workspace_id.clone(),
            workspace_path.clone(),
            session_path.clone(),
            self.repository_root.clone(),
            self.config_path.clone(),
            token,
        );
        let descriptor_path = self.paths.worker_descriptor(&worker_id);
        write_descriptor(&descriptor_path, &descriptor)?;
        let agent = AgentRecord {
            agent_id: agent_id.clone(),
            root_agent_id: agent_id.clone(),
            workspace_id,
            workspace_path,
            session_id: None,
            session_path,
            worker_id: worker_id.clone(),
            name: parameters
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: "starting".into(),
            controller_client_id: None,
            created_at_ms: now_ms(),
        };
        if let Err(error) = self.database.upsert_agent(&agent) {
            let _ = fs::remove_file(&descriptor_path);
            return Err(error);
        }
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .insert(agent_id.clone(), agent);

        spawn_worker_proxy(&descriptor_path)?;
        let connected_descriptor = wait_for_worker(&descriptor_path, Duration::from_secs(20))?;
        let worker = connect_worker(connected_descriptor.clone(), self.database.clone())?;
        self.database
            .upsert_worker(&connected_descriptor, &descriptor_path)?;
        self.workers
            .lock()
            .expect("workers mutex poisoned")
            .insert(worker_id, Arc::clone(&worker));
        let snapshot = worker.call("session.snapshot", json!({}), WORKER_RPC_TIMEOUT)?;
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
            self.database.upsert_agent(current)?;
        }
        Ok(json!({
            "agent": self.public_agent(&agent_id)?,
            "snapshot": decorate_snapshot(
                &connected_descriptor,
                worker.generation.load(Ordering::SeqCst),
                &agent_id,
                snapshot_sequence,
                snapshot,
            )
        }))
    }

    fn submit_turn(
        &self,
        agent_id: &str,
        parameters: Value,
        goal_id: Option<&str>,
    ) -> Result<Value> {
        let message = parameters
            .get("message")
            .and_then(Value::as_str)
            .context("turn.submit requires message")?;
        if message.is_empty() {
            bail!("turn message cannot be empty")
        }
        if message.len() > 256 * 1024 {
            bail!("turn message exceeds the 256 KiB limit")
        }
        enforce_model_quotas(&parameters)?;
        let worker = self.worker_for_agent(agent_id)?;
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        self.database
            .acquire_workspace_lease(&worker.descriptor.workspace_id, &root_agent_id)?;
        let result = if root_agent_id == agent_id {
            worker.call("turn.submit", parameters, WORKER_RPC_TIMEOUT)
        } else {
            worker.call(
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
                let _ = self
                    .database
                    .release_workspace_lease(&worker.descriptor.workspace_id, &root_agent_id);
                return Err(error);
            }
        };
        let request_id = result
            .get("request_id")
            .and_then(Value::as_str)
            .context("worker accepted a turn without request_id")?;
        self.database.record_task(agent_id, request_id)?;
        if let Some(goal_id) = goal_id {
            self.database.record_goal_run(goal_id, request_id)?;
        }
        Ok(result)
    }

    fn list_agents(&self) -> Vec<Value> {
        let agents = self.agents.lock().expect("agents mutex poisoned");
        let mut values: Vec<_> = agents.values().map(public_agent_value).collect();
        drop(agents);
        let workers: Vec<_> = self
            .workers
            .lock()
            .expect("workers mutex poisoned")
            .values()
            .cloned()
            .collect();
        for worker in &workers {
            for value in &mut values {
                if value.get("worker_id").and_then(Value::as_str)
                    == Some(worker.descriptor.worker_id.as_str())
                {
                    decorate_public_agent_runtime(value, worker);
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
        let worker_id = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get(agent_id)
            .map(|agent| agent.worker_id.clone());
        if let Some(worker_id) = worker_id {
            return self
                .workers
                .lock()
                .expect("workers mutex poisoned")
                .get(&worker_id)
                .cloned()
                .with_context(|| format!("worker is unavailable for agent {agent_id}"));
        }
        self.find_child(agent_id)?
            .map(|(worker, _)| worker)
            .with_context(|| format!("agent was not found: {agent_id}"))
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
        self.public_agent(to_agent_id)?;
        let command_id = command
            .command_id
            .as_deref()
            .context("agent.message.send requires command_id")?;
        let message_id = format!(
            "msg-{}",
            Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{}:{command_id}", command.client_id).as_bytes(),
            )
        );
        self.database
            .record_message(&message_id, from_agent_id, to_agent_id, message)?;

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
        let snapshot = if root_agent_id == agent_id {
            worker.call("session.snapshot", json!({}), WORKER_RPC_TIMEOUT)?
        } else {
            worker.call(
                "subagent.invoke",
                json!({"agent_id": agent_id, "method": "session.snapshot", "params": {}}),
                WORKER_RPC_TIMEOUT,
            )?
        };
        let snapshot_sequence =
            worker.attach_at_sequence(attachment_id.to_owned(), agent_id.to_owned(), sender);
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

    fn stop_agent(&self, agent_id: &str) -> Result<Value> {
        let worker = self.worker_for_agent(agent_id)?;
        let root_agent_id = self.root_agent_id_for(agent_id)?;
        if root_agent_id != agent_id {
            return worker.call(
                "subagent.stop",
                json!({"agent_id": agent_id}),
                Duration::from_secs(3),
            );
        }
        let result = worker
            .call("shutdown", json!({}), Duration::from_secs(3))
            .unwrap_or_else(|_| json!({"shutting-down": true}));
        if let Some(agent) = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .get_mut(agent_id)
        {
            agent.status = "stopped".into();
            self.database.upsert_agent(agent)?;
        }
        Ok(result)
    }

    fn stop_all_workers(&self) {
        let agent_ids: Vec<_> = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .keys()
            .cloned()
            .collect();
        for agent_id in agent_ids {
            let _ = self.stop_agent(&agent_id);
        }
    }
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
    let mut attached_workers: HashMap<String, Arc<WorkerConnection>> = HashMap::new();
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

        let result = dispatch(
            &runtime,
            &command,
            &attachment_id,
            event_tx.clone(),
            &mut attached_workers,
        );
        match result {
            Ok(result) => {
                if let Some(command_id) = command.command_id.as_deref()
                    && wire::mutation(&command.method)
                {
                    runtime.database.finish_command(
                        &command.client_id,
                        command_id,
                        "completed",
                        &result,
                    )?;
                }
                write_command_response(&writer, &command.request_id, result)?;
                if command.method == "daemon.shutdown" {
                    schedule_shutdown(&runtime);
                    break;
                }
            }
            Err(error) => {
                let uncertain =
                    wire::mutation(&command.method) && uncertain_worker_failure(&error.to_string());
                let error_data = if uncertain {
                    json!({"status": "uncertain"})
                } else {
                    Value::Null
                };
                let failure = json!({"message": error.to_string(), "data": error_data});
                if let Some(command_id) = command.command_id.as_deref()
                    && wire::mutation(&command.method)
                    && !uncertain
                {
                    runtime.database.finish_command(
                        &command.client_id,
                        command_id,
                        "failed",
                        &failure,
                    )?;
                }
                write_value(
                    &writer,
                    &wire::error_response(&command.request_id, error.to_string(), error_data),
                )?;
            }
        }
    }
    for (agent_id, worker) in &attached_workers {
        worker.detach(&attachment_id);
        if let Some(client_id) = stable_client_id.as_deref() {
            let _ = runtime.release_control(agent_id, client_id);
        }
    }
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
        "daemon.hello" => Ok(json!({
            "protocol_version": PROTOCOL_VERSION,
            "daemon_version": env!("CARGO_PKG_VERSION"),
            "capabilities": [
                "agent.attach", "cursor.generation", "command.idempotency",
                "controller.lease", "worker.adoption", "repl.v1",
                "schedule.v1", "goal.v1", "durable.messaging.v1"
            ]
        })),
        "daemon.status" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "socket": runtime.paths.public_socket,
            "database": runtime.paths.database,
            "agents": runtime.list_agents(),
            "worker_count": runtime.workers.lock().expect("workers mutex poisoned").len(),
            "worker_quota": configured_max_workers(),
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
        "daemon.update" => {
            let purged_expired_leases = runtime.database.purge_expired_leases()?;
            runtime.adopt_workers();
            runtime.recover_missing_workers();
            Ok(json!({
                "updated": true,
                "purged_expired_leases": purged_expired_leases,
                "worker_count": runtime.workers.lock().expect("workers mutex poisoned").len(),
            }))
        }
        "daemon.shutdown" => Ok(json!({"shutting_down": true})),
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
        "agent.message.send" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            runtime.route_agent_message(command)
        }
        "agent.message.receive" | "agent.message.record_sent" | "subagent.invoke" => {
            bail!("method is private to the daemon-worker protocol")
        }
        "schedule.add" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            let (expression, next_at_ms) = schedule_spec(&command.params)?;
            let prompt = command
                .params
                .get("prompt")
                .and_then(Value::as_str)
                .context("schedule.add requires prompt")?;
            if prompt.is_empty() || prompt.len() > 256 * 1024 {
                bail!("schedule prompt must be between 1 byte and 256 KiB")
            }
            let max_attempts = command
                .params
                .get("max_attempts")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .clamp(1, 10);
            let retry_delay_ms = command
                .params
                .get("retry_delay_ms")
                .and_then(Value::as_u64)
                .unwrap_or(1_000)
                .clamp(100, 60_000);
            runtime.database.add_schedule(
                agent_id,
                &expression,
                next_at_ms,
                &json!({
                    "prompt": prompt,
                    "attempts": 0,
                    "max_attempts": max_attempts,
                    "retry_delay_ms": retry_delay_ms,
                }),
            )
        }
        "schedule.list" => {
            let agent_id = command
                .params
                .get("agent_id")
                .and_then(Value::as_str)
                .or(command.agent_id.as_deref());
            Ok(Value::Array(runtime.database.list_schedules(agent_id)?))
        }
        "schedule.cancel" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            let schedule_id = command
                .params
                .get("schedule_id")
                .and_then(Value::as_str)
                .context("schedule.cancel requires schedule_id")?;
            let owned = runtime
                .database
                .list_schedules(Some(agent_id))?
                .iter()
                .any(|schedule| {
                    schedule.get("schedule_id").and_then(Value::as_str) == Some(schedule_id)
                });
            if !owned {
                bail!("schedule does not belong to agent")
            }
            Ok(json!({"cancelled": runtime.database.cancel_schedule(schedule_id)?}))
        }
        "goal.set" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            let objective = command
                .params
                .get("objective")
                .and_then(Value::as_str)
                .context("goal.set requires objective")?;
            if objective.is_empty() || objective.len() > 256 * 1024 {
                bail!("goal objective must be between 1 byte and 256 KiB")
            }
            let max = command
                .params
                .get("max_continuations")
                .and_then(Value::as_u64)
                .unwrap_or(3)
                .min(20);
            let goal = runtime.database.create_goal(agent_id, objective, max)?;
            let goal_id = goal
                .get("goal_id")
                .and_then(Value::as_str)
                .context("created goal has no id")?;
            match runtime.submit_turn(agent_id, json!({"message": objective}), Some(goal_id)) {
                Ok(run) => Ok(json!({"goal": goal, "run": run})),
                Err(error) => {
                    let _ = runtime
                        .database
                        .mark_goal_error(goal_id, &error.to_string());
                    Err(error)
                }
            }
        }
        "goal.list" => {
            let agent_id = command
                .params
                .get("agent_id")
                .and_then(Value::as_str)
                .or(command.agent_id.as_deref());
            Ok(Value::Array(runtime.database.list_goals(agent_id)?))
        }
        "goal.status" => {
            let goal_id = command
                .params
                .get("goal_id")
                .and_then(Value::as_str)
                .context("goal.status requires goal_id")?;
            runtime
                .database
                .list_goals(command.agent_id.as_deref())?
                .into_iter()
                .find(|goal| goal.get("goal_id").and_then(Value::as_str) == Some(goal_id))
                .context("goal was not found")
        }
        "goal.cancel" | "goal.complete" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            let goal_id = command
                .params
                .get("goal_id")
                .and_then(Value::as_str)
                .context("goal mutation requires goal_id")?;
            let owned = runtime
                .database
                .list_goals(Some(agent_id))?
                .iter()
                .any(|goal| goal.get("goal_id").and_then(Value::as_str) == Some(goal_id));
            if !owned {
                bail!("goal does not belong to agent")
            }
            let status = if command.method == "goal.complete" {
                "completed"
            } else {
                "cancelled"
            };
            Ok(json!({
                "goal_id": goal_id,
                "status": status,
                "updated": runtime.database.set_goal_status(goal_id, status)?,
            }))
        }
        "goal.resume" => {
            let agent_id = require_agent_id(command)?;
            runtime.assert_controller(agent_id, &command.client_id)?;
            let goal_id = command
                .params
                .get("goal_id")
                .and_then(Value::as_str)
                .context("goal.resume requires goal_id")?;
            let goal = runtime
                .database
                .list_goals(Some(agent_id))?
                .into_iter()
                .find(|goal| goal.get("goal_id").and_then(Value::as_str) == Some(goal_id))
                .context("goal does not belong to agent")?;
            let status = goal
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(status, "uncertain" | "blocked") {
                bail!("only uncertain or blocked goals can be resumed")
            }
            let objective = goal
                .get("objective")
                .and_then(Value::as_str)
                .context("goal has no objective")?;
            runtime.database.set_goal_status(goal_id, "active")?;
            match runtime.submit_turn(
                agent_id,
                json!({
                    "message": format!(
                        "Resume this durable goal after explicit reconciliation. Inspect current state before making further changes.\n\nGoal: {objective}"
                    )
                }),
                Some(goal_id),
            ) {
                Ok(run) => Ok(json!({"goal_id": goal_id, "status": "active", "run": run})),
                Err(error) => {
                    let _ = runtime.database.mark_goal_error(goal_id, &error.to_string());
                    Err(error)
                }
            }
        }
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
    std::env::var("DAO_MAX_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(8)
}

fn configured_max_tokens_per_run() -> Option<u64> {
    std::env::var("DAO_MAX_TOKENS_PER_RUN")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn configured_allowed_providers() -> Vec<String> {
    std::env::var("DAO_ALLOWED_PROVIDERS")
        .ok()
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
            "turn must select options.model_options.provider when DAO_ALLOWED_PROVIDERS is set",
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

fn schedule_spec(parameters: &Value) -> Result<(String, i64)> {
    let now = now_ms_i64();
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
        let at_ms = now.saturating_add(delay_ms);
        return Ok((format!("at:{at_ms}"), at_ms));
    }
    if let Some(every_ms) = parameters.get("every_ms").and_then(Value::as_u64) {
        let every_ms = i64::try_from(every_ms).context("schedule interval is too large")?;
        if every_ms < 100 {
            bail!("schedule every_ms must be at least 100")
        }
        return Ok((format!("@every {every_ms}ms"), now.saturating_add(every_ms)));
    }
    let expression = parameters
        .get("expression")
        .and_then(Value::as_str)
        .context("schedule.add requires at_ms, delay_ms, every_ms, or expression")?;
    let next = next_schedule_time(expression, now)
        .with_context(|| format!("unsupported schedule expression: {expression}"))?;
    Ok((expression.to_owned(), next))
}

fn next_schedule_time(expression: &str, after_ms: i64) -> Option<i64> {
    if expression.starts_with("at:") {
        return None;
    }
    if let Some(duration) = expression.strip_prefix("@every ") {
        let milliseconds = duration.strip_suffix("ms")?.parse::<i64>().ok()?;
        return (milliseconds >= 100).then(|| after_ms.saturating_add(milliseconds));
    }
    let fields: Vec<_> = expression.split_whitespace().collect();
    if fields.len() != 5 || fields[1..] != ["*", "*", "*", "*"] {
        return None;
    }
    let minute_ms = 60_000i64;
    let next_minute = after_ms
        .div_euclid(minute_ms)
        .saturating_add(1)
        .saturating_mul(minute_ms);
    if fields[0] == "*" {
        return Some(next_minute);
    }
    if let Some(step) = fields[0].strip_prefix("*/") {
        let step = step.parse::<i64>().ok()?;
        if !(1..=59).contains(&step) {
            return None;
        }
        let current_minute = next_minute.div_euclid(minute_ms);
        let remainder = current_minute.rem_euclid(step);
        let delta = if remainder == 0 { 0 } else { step - remainder };
        return Some(next_minute.saturating_add(delta.saturating_mul(minute_ms)));
    }
    let target = fields[0].parse::<i64>().ok()?;
    if !(0..=59).contains(&target) {
        return None;
    }
    let current = next_minute.div_euclid(minute_ms).rem_euclid(60);
    let delta = (target - current).rem_euclid(60);
    Some(next_minute.saturating_add(delta.saturating_mul(minute_ms)))
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

fn run_schedule_claim(runtime: &Runtime, claim: ScheduleClaim) {
    let prompt = claim
        .policy
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let result = runtime.submit_turn(&claim.agent_id, json!({"message": prompt}), None);
    let mut policy = claim.policy.clone();
    if result.is_ok() {
        if let Some(object) = policy.as_object_mut() {
            object.insert("attempts".into(), json!(0));
        }
        let next = next_schedule_time(&claim.expression, now_ms_i64());
        let status = if next.is_some() {
            "active"
        } else {
            "completed"
        };
        let _ = runtime
            .database
            .finish_schedule_claim(&claim, status, next, &policy);
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
        object.insert(
            "last_error".into(),
            json!(result.err().map(|error| error.to_string())),
        );
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
    let _ = runtime
        .database
        .finish_schedule_claim(&claim, status, next, &policy);
}

fn spawn_goal_continuation(
    connection: Arc<WorkerConnection>,
    database: Database,
    continuation: GoalContinuation,
) {
    thread::spawn(move || {
        let owner = &connection.descriptor.root_agent_id;
        if let Err(error) =
            database.acquire_workspace_lease(&connection.descriptor.workspace_id, owner)
        {
            let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
            return;
        }
        let prompt = format!(
            "Continue the durable goal below. Inspect the current session and workspace, make the next safe unit of progress, and report blockers explicitly.\n\nGoal: {}\n\nContinuation {}/{}.",
            continuation.objective, continuation.continuation_count, continuation.max_continuations,
        );
        let result = if continuation.agent_id == connection.descriptor.root_agent_id {
            connection.call(
                "turn.submit",
                json!({"message": prompt}),
                WORKER_RPC_TIMEOUT,
            )
        } else {
            connection.call(
                "subagent.invoke",
                json!({
                    "agent_id": continuation.agent_id,
                    "method": "turn.submit",
                    "params": {"message": prompt},
                }),
                WORKER_RPC_TIMEOUT,
            )
        };
        match result {
            Ok(result) => {
                if let Some(request_id) = result.get("request_id").and_then(Value::as_str)
                    && database
                        .record_task(&continuation.agent_id, request_id)
                        .and_then(|_| database.record_goal_run(&continuation.goal_id, request_id))
                        .is_ok()
                {
                    return;
                }
                let _ = database.mark_goal_error(
                    &continuation.goal_id,
                    "continued goal was accepted without a durable request id",
                );
            }
            Err(error) => {
                let _ = database.mark_goal_error(&continuation.goal_id, &error.to_string());
            }
        }
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
    });
    let reader_connection = Arc::clone(&connection);
    thread::spawn(move || worker_reader(reader_connection, reader, database));
    Ok(connection)
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
                let _ = database.release_workspace_lease(
                    &connection.descriptor.workspace_id,
                    &connection.descriptor.root_agent_id,
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
    connection.alive.store(false, Ordering::SeqCst);
    let _ = database.release_workspace_lease(
        &connection.descriptor.workspace_id,
        &connection.descriptor.root_agent_id,
    );
    *connection
        .status
        .lock()
        .expect("worker status mutex poisoned") = "unavailable".into();
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

fn spawn_worker_proxy(descriptor_path: &Path) -> Result<()> {
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .arg("worker")
        .arg("serve")
        .arg("--descriptor")
        .arg(descriptor_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .spawn()
        .context("could not launch resident worker proxy")?;
    Ok(())
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

fn public_agent_value(agent: &AgentRecord) -> Value {
    json!({
        "agent_id": agent.agent_id,
        "root_agent_id": agent.root_agent_id,
        "workspace_id": agent.workspace_id,
        "workspace_path": agent.workspace_path,
        "session_id": agent.session_id,
        "session_path": agent.session_path,
        "worker_id": agent.worker_id,
        "name": agent.name,
        "status": agent.status,
        "controller_client_id": agent.controller_client_id,
        "created_at_ms": agent.created_at_ms
    })
}

fn decorate_public_agent_runtime(value: &mut Value, worker: &WorkerConnection) {
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
    }
}

fn child_agent_value(descriptor: &WorkerDescriptor, generation: u64, child: &Value) -> Value {
    let agent_id = child
        .get("agent_id")
        .or_else(|| child.get("id"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "agent_id": agent_id,
        "root_agent_id": descriptor.root_agent_id,
        "workspace_id": descriptor.workspace_id,
        "workspace_path": descriptor.workspace_path,
        "session_id": child.get("session-id").or_else(|| child.get("session_id")),
        "session_path": child.get("session-path").or_else(|| child.get("session_path")),
        "worker_id": descriptor.worker_id,
        "generation": generation,
        "name": child.get("label"),
        "status": child.get("status"),
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

fn doctor(runtime: &Runtime, fix: bool) -> Value {
    let purged_expired_leases = if fix {
        runtime.database.purge_expired_leases().unwrap_or(0)
    } else {
        0
    };
    let workers = runtime.workers.lock().expect("workers mutex poisoned");
    let values: Vec<_> = workers
        .values()
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
    json!({
        "ok": values
            .iter()
            .all(|worker| worker.get("alive") == Some(&Value::Bool(true))),
        "daemon_pid": std::process::id(),
        "schema_revision": 2,
        "socket": runtime.paths.public_socket,
        "database": runtime.paths.database,
        "workers": values,
        "schedules": runtime.database.list_schedules(None).unwrap_or_default(),
        "goals": runtime.database.list_goals(None).unwrap_or_default(),
        "quotas": {
            "max_workers": configured_max_workers(),
            "max_turn_bytes": 256 * 1024,
            "max_goal_continuations": 20,
            "workspace_write_roots": 1,
            "allowed_providers": configured_allowed_providers(),
            "max_tokens_per_run": configured_max_tokens_per_run(),
            "worker_cpu_seconds": std::env::var("DAO_WORKER_CPU_SECONDS").ok(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_journal_replays_completed_outcome_and_rejects_conflicts() {
        let root = std::env::temp_dir().join(format!("dao-db-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = Database::new(root.join("supervisor.sqlite")).unwrap();
        let command = PublicCommand {
            version: 1,
            kind: "command".into(),
            request_id: "request-1".into(),
            client_id: "client-1".into(),
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
            socket_path: PathBuf::from("/tmp/worker.sock"),
            token: "secret".into(),
            generation: 4,
            pid: None,
            child_pid: None,
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
    fn interrupted_schedule_tick_is_not_replayed() {
        let root = std::env::temp_dir().join(format!("dao-schedule-test-{}", Uuid::new_v4()));
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
            socket_path: PathBuf::from("/tmp/worker.sock"),
            token: "secret".into(),
            generation: 1,
            pid: None,
            child_pid: None,
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
