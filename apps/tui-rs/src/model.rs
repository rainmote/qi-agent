use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

pub type JsonObject = Map<String, Value>;

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Cursor {
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub sequence: u64,
}

impl<'de> Deserialize<'de> for Cursor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum CursorValue {
            Sequence(u64),
            Full {
                #[serde(default)]
                generation: u64,
                #[serde(default)]
                sequence: u64,
            },
        }
        Ok(match CursorValue::deserialize(deserializer)? {
            CursorValue::Sequence(sequence) => Self {
                generation: 0,
                sequence,
            },
            CursorValue::Full {
                generation,
                sequence,
            } => Self {
                generation,
                sequence,
            },
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Snapshot {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub cursor: Cursor,
    #[serde(default)]
    pub events: Vec<DurableEvent>,
    #[serde(default)]
    pub state: JsonObject,
    #[serde(default)]
    pub models: Option<ModelList>,
    #[serde(default)]
    pub interactions: Vec<Value>,
    #[serde(default)]
    pub interactions_revision: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct DurableEvent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub at: String,
    #[serde(rename = "type", default)]
    pub event: String,
    #[serde(default)]
    pub data: JsonObject,
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Envelope {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonObject>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub generation: Option<u64>,
    #[serde(default)]
    pub cursor: Option<Cursor>,
    #[serde(default)]
    pub durable: Option<bool>,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub data: JsonObject,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct ModelList {
    #[serde(default)]
    pub current: Option<Model>,
    #[serde(default)]
    pub providers: Vec<Model>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Model {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunOutcome {
    pub run_id: String,
    pub status: String,
    pub reason: Option<String>,
    pub verification: String,
    pub error: Option<String>,
}

impl RunOutcome {
    pub fn text(&self) -> String {
        let status = match self.status.as_str() {
            "completed" => "运行完成",
            "failed" => "运行失败",
            "cancelled" => "运行已取消",
            _ => "结果未确认 · 需要核对",
        };
        let verification = match self.verification.as_str() {
            "passed" | "verified" => "验收通过",
            "failed" => "验收失败",
            "unknown" => "验收结果未知",
            _ => "尚未验收",
        };
        let reason = match self.reason.as_deref() {
            Some("no-progress") => Some("连续调用没有进展"),
            Some("step-budget") => Some("步数已达上限"),
            Some("request-budget") => Some("请求数已达上限"),
            Some("wall-budget") => Some("运行时间已达上限"),
            Some("tool-terminated") => Some("工具策略终止"),
            Some("provider-error") => Some("模型请求失败"),
            Some("summary-failed") => Some("上下文整理失败"),
            Some("output-limit") => Some("输出达到上限"),
            Some("restored") => Some("中断后恢复"),
            _ => None,
        };
        [
            Some(status),
            Some(verification),
            reason,
            self.error.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompactionProgress {
    pub compaction_id: String,
    pub completed_chunks: u64,
    pub total_chunks: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentState {
    pub phase: String,
    pub run_id: Option<String>,
    pub partial_assistant: String,
    pub partial_reasoning: String,
    pub last_error: Option<String>,
    pub last_outcome: Option<RunOutcome>,
    pub compaction: Option<CompactionProgress>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HistoryItem {
    User {
        id: String,
        text: String,
    },
    Assistant {
        id: String,
        text: String,
        reasoning: Option<String>,
        streaming: bool,
    },
    ToolGroup {
        id: String,
        tools: Vec<ToolCall>,
        batch_key: Option<String>,
    },
    Info {
        id: String,
        text: String,
    },
    Error {
        id: String,
        text: String,
    },
}

impl HistoryItem {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. }
            | Self::Assistant { id, .. }
            | Self::ToolGroup { id, .. }
            | Self::Info { id, .. }
            | Self::Error { id, .. } => id,
        }
    }

    pub fn is_final(&self) -> bool {
        match self {
            Self::Assistant { streaming, .. } => !streaming,
            Self::ToolGroup { tools, .. } => {
                !tools.is_empty()
                    && tools.iter().all(|tool| {
                        matches!(
                            tool.status,
                            ToolStatus::Success | ToolStatus::Error | ToolStatus::Canceled
                        )
                    })
            }
            Self::User { .. } | Self::Info { .. } | Self::Error { .. } => true,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub status: ToolStatus,
    pub updates: Vec<Value>,
    pub result: Option<ToolResult>,
    pub execution_started_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ToolStatus {
    #[default]
    Pending,
    Confirming,
    Running,
    Success,
    Error,
    Canceled,
}

impl ToolStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Success | Self::Error | Self::Canceled)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolResult {
    pub ok: bool,
    pub cancelled: bool,
    pub content: String,
    pub error: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueueItem {
    pub id: String,
    pub kind: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InteractionChoice {
    pub label: String,
    pub value: Value,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Interaction {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub items: Vec<InteractionChoice>,
    pub default: Value,
    pub required: bool,
    pub placeholder: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UiProjection {
    pub session_id: String,
    pub cursor: Cursor,
    pub history: Vec<HistoryItem>,
    pub state: AgentState,
    pub state_revision: Option<u64>,
    pub snapshot_interaction_revision: Option<u64>,
    pub interaction_revisions: BTreeMap<String, u64>,
    pub queue: Vec<QueueItem>,
    pub interactions: Vec<Interaction>,
    pub models: Option<ModelList>,
    pub theme: Option<String>,
    pub statuses: BTreeMap<String, Value>,
    pub widgets: BTreeMap<String, Value>,
    pub shortcuts: BTreeMap<String, Value>,
    pub notifications: Vec<Notification>,
    pub seen_event_ids: HashSet<String>,
    pub current_batch: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Notification {
    pub id: String,
    pub text: String,
    pub level: String,
}
