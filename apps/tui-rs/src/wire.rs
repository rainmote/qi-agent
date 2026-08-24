use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PublicCommand {
    #[serde(default = "protocol_version")]
    pub version: u32,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default, alias = "id")]
    pub request_id: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn protocol_version() -> u32 {
    PROTOCOL_VERSION
}

pub fn response(id: &str, result: Value) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "type": "response",
        "id": id,
        "ok": true,
        "result": result
    })
}

pub fn error_response(id: &str, message: impl Into<String>, data: Value) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "type": "response",
        "id": id,
        "ok": false,
        "error": {"message": message.into(), "data": data}
    })
}

pub fn command(
    request_id: impl Into<String>,
    client_id: impl Into<String>,
    command_id: Option<String>,
    agent_id: Option<String>,
    method: impl Into<String>,
    params: Value,
) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "type": "command",
        "request_id": request_id.into(),
        "client_id": client_id.into(),
        "command_id": command_id,
        "agent_id": agent_id,
        "method": method.into(),
        "params": params
    })
}

pub fn mutation(method: &str) -> bool {
    matches!(
        method,
        "agent.create"
            | "agent.rename"
            | "agent.stop"
            | "agent.take_control"
            | "prompt.submit"
            | "prompt.steer"
            | "prompt.follow_up"
            | "turn.submit"
            | "turn.steer"
            | "turn.follow-up"
            | "turn.abort"
            | "run.abort"
            | "session.rename"
            | "session.clear"
            | "session.fork"
            | "session.compact"
            | "interaction.resolve"
            | "ui.prompt.resolve"
            | "ui.shortcut.invoke"
            | "model.select"
            | "command.execute"
            | "repl.eval"
            | "repl.interrupt"
            | "repl.reset"
            | "state.put"
            | "state.delete"
            | "agent.message.send"
            | "subagent.stop"
            | "subagent.delete"
            | "schedule.add"
            | "schedule.cancel"
            | "goal.set"
            | "goal.cancel"
            | "goal.complete"
            | "goal.resume"
            | "daemon.update"
            | "daemon.shutdown"
    )
}

pub fn worker_method(method: &str) -> &str {
    match method {
        "prompt.submit" => "turn.submit",
        "prompt.steer" => "turn.steer",
        "prompt.follow_up" => "turn.follow-up",
        "run.abort" => "turn.abort",
        "run.status" => "turn.state",
        other => other,
    }
}
