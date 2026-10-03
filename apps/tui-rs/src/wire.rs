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
    pub journal_id: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl PublicCommand {
    pub fn journal_client_id(&self) -> &str {
        self.journal_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .unwrap_or(&self.client_id)
    }
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
    // Only explicitly reviewed reads and connection lifecycle operations are
    // exempt. New/plugin methods require controller authority and a journal id.
    static METHODS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    !METHODS
        .get_or_init(|| {
            let catalog: serde_json::Value =
                serde_json::from_str(include_str!("../../../protocol/methods.json"))
                    .expect("valid shared method catalog");
            ["readOnly", "connection"]
                .iter()
                .flat_map(|key| {
                    catalog[*key]
                        .as_array()
                        .expect("method list")
                        .iter()
                        .map(|value| value.as_str().expect("method name").to_owned())
                })
                .collect()
        })
        .iter()
        .any(|entry| entry == method)
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_settings_methods_require_mutation_authority() {
        for method in [
            "policy.select",
            "model.thinking.select",
            "provider.settings.reload",
            "plugin.new-method",
        ] {
            assert!(mutation(method), "{method}");
        }
        for method in [
            "model.list",
            "policy.status",
            "session.snapshot",
            "command.status",
            "agent.attach",
        ] {
            assert!(!mutation(method), "{method}");
        }
    }
}
