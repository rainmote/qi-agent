use crate::model::*;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn value_at<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| map.get(*key))
}

fn string_at(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    value_at(map, keys)?.as_str().map(ToOwned::to_owned)
}

fn u64_at(map: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    value_at(map, keys)?.as_u64()
}

fn object_at<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    value_at(map, keys)?.as_object()
}

fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str().map(ToOwned::to_owned).or_else(|| {
                    part.as_object()
                        .and_then(|entry| string_at(entry, &["text", "content"]))
                })
            })
            .collect(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => String::new(),
    }
}

fn normalize_state(raw: &Map<String, Value>) -> AgentState {
    AgentState {
        phase: string_at(raw, &["phase"]).unwrap_or_else(|| "idle".into()),
        run_id: string_at(raw, &["runId", "run-id", "run_id"]),
        partial_assistant: string_at(
            raw,
            &["partialAssistant", "partial-assistant", "partial_assistant"],
        )
        .unwrap_or_default(),
        partial_reasoning: string_at(
            raw,
            &["partialReasoning", "partial-reasoning", "partial_reasoning"],
        )
        .unwrap_or_default(),
        last_error: string_at(raw, &["lastError", "last-error", "last_error"]),
    }
}

fn normalize_interaction(value: &Value) -> Option<Interaction> {
    let raw = value.as_object()?;
    let prompt = raw.get("prompt").and_then(Value::as_object).unwrap_or(raw);
    let id = string_at(raw, &["id"])?;
    let mut items = Vec::new();
    if let Some(values) = value_at(prompt, &["items", "options"]).and_then(Value::as_array) {
        for value in values {
            if let Some(entry) = value.as_object() {
                let option = entry.get("value").cloned().unwrap_or_else(|| value.clone());
                let label = string_at(entry, &["label"]).unwrap_or_else(|| match &option {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                });
                items.push(InteractionChoice {
                    label,
                    value: option,
                });
            } else {
                items.push(InteractionChoice {
                    label: value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                    value: value.clone(),
                });
            }
        }
    }
    let approval = !items.is_empty()
        && items.iter().all(|item| {
            item.value
                .as_str()
                .is_some_and(|v| matches!(v, "allow" | "allow-session" | "deny"))
        });
    Some(Interaction {
        id,
        kind: if approval {
            "approval".into()
        } else {
            string_at(raw, &["kind"])
                .or_else(|| string_at(prompt, &["kind"]))
                .unwrap_or_else(|| "select".into())
        },
        title: string_at(raw, &["title"])
            .or_else(|| string_at(prompt, &["title"]))
            .unwrap_or_else(|| "Confirmation required".into()),
        message: string_at(raw, &["message"])
            .or_else(|| string_at(prompt, &["message"]))
            .unwrap_or_default(),
        items,
        default: value_at(prompt, &["default"])
            .cloned()
            .unwrap_or(Value::Null),
        required: value_at(prompt, &["required?", "required"])
            .and_then(Value::as_bool)
            .unwrap_or(false),
        placeholder: string_at(prompt, &["placeholder"]),
    })
}

pub fn from_snapshot(snapshot: Snapshot) -> UiProjection {
    let mut projection = UiProjection {
        session_id: snapshot.session_id,
        cursor: snapshot.cursor,
        state: normalize_state(&snapshot.state),
        interactions: snapshot
            .interactions
            .iter()
            .filter_map(normalize_interaction)
            .collect(),
        models: snapshot.models,
        ..UiProjection::default()
    };
    let mut events = snapshot.events;
    events.sort_by_key(|event| event.seq);
    for event in events {
        if !event.id.is_empty() && !projection.seen_event_ids.insert(event.id.clone()) {
            continue;
        }
        projection = apply_event(
            projection,
            &event.event,
            &event.data,
            Some(&event.id),
            event.run_id.as_deref(),
            Some(event.seq),
        );
    }
    sync_streaming(&mut projection);
    projection
}

pub fn apply_envelope(mut projection: UiProjection, envelope: &Envelope) -> UiProjection {
    if envelope.kind != "event" {
        return projection;
    }
    if let Some(id) = envelope.event_id.as_ref()
        && !projection.seen_event_ids.insert(id.clone())
    {
        return projection;
    }
    let Some(event) = envelope.event.as_deref() else {
        return projection;
    };
    projection = apply_event(
        projection,
        event,
        &envelope.data,
        envelope.event_id.as_deref(),
        envelope.run_id.as_deref(),
        envelope.seq,
    );
    if let Some(cursor) = envelope.cursor {
        projection.cursor = cursor;
    } else if let Some(generation) = envelope.generation {
        projection.cursor.generation = generation;
    }
    sync_streaming(&mut projection);
    projection
}

fn apply_event(
    mut projection: UiProjection,
    event: &str,
    data: &Map<String, Value>,
    event_id: Option<&str>,
    run_id: Option<&str>,
    seq: Option<u64>,
) -> UiProjection {
    let fallback_id = event_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("live:{}", seq.unwrap_or(0)));
    match event {
        "message" | "session/message" => add_message(&mut projection, data, fallback_id),
        "agent/state" | "runtime/state" => {
            let previous_phase = projection.state.phase.clone();
            projection.state = normalize_state(object_at(data, &["state"]).unwrap_or(data));
            if previous_phase != "idle" && projection.state.phase == "idle" {
                terminalize_open_tools(&mut projection, "Turn ended before tool completion");
            }
        }
        "llm/stream" => {
            let stream_type = string_at(data, &["type"]).unwrap_or_default();
            let delta = string_at(data, &["delta"]).unwrap_or_default();
            if !delta.is_empty() {
                projection.state.phase = "model".into();
                if stream_type == "text/delta" {
                    projection.state.partial_assistant.push_str(&delta);
                } else if stream_type == "reasoning/delta" {
                    projection.state.partial_reasoning.push_str(&delta);
                }
            }
        }
        "step/start" => {
            projection.current_batch = string_at(data, &["batch-key", "batch_key", "batchKey"])
                .or_else(|| {
                    u64_at(data, &["step"])
                        .map(|step| format!("{}:step:{}", run_id.unwrap_or("run"), step))
                });
        }
        "step/end" => projection.current_batch = None,
        "tool/call" => add_tool(&mut projection, data, fallback_id, run_id),
        "tool/result" => finish_tool(&mut projection, data, run_id),
        "tool.execution/confirming" => {
            update_tool_status(&mut projection, data, ToolStatus::Confirming, run_id)
        }
        "tool.execution/start" => {
            update_tool_status(&mut projection, data, ToolStatus::Running, run_id)
        }
        "tool.execution/update" => {
            update_tool_status(&mut projection, data, ToolStatus::Running, run_id);
            if let Some(update) = value_at(data, &["update"]).cloned()
                && let Some(tool) = find_tool_mut(&mut projection, data, run_id)
            {
                tool.updates.push(update);
                if tool.updates.len() > 32 {
                    tool.updates.remove(0);
                }
            }
        }
        "tool.execution/end" => finish_tool(&mut projection, data, run_id),
        "interaction/request" => {
            let fallback = Value::Object(data.clone());
            let source = value_at(data, &["interaction", "request"]).unwrap_or(&fallback);
            if let Some(interaction) = normalize_interaction(source) {
                projection
                    .interactions
                    .retain(|item| item.id != interaction.id);
                projection.interactions.push(interaction);
            }
        }
        "interaction/resolved" | "approval/event" => {
            if let Some(id) = string_at(data, &["id", "interaction-id", "interaction_id"]) {
                projection.interactions.retain(|item| item.id != id);
            }
        }
        "ui/extensions" => match string_at(data, &["kind"]).as_deref() {
            Some("notification") => add_notification(
                &mut projection,
                object_at(data, &["notification"]).unwrap_or(data),
                fallback_id,
            ),
            _ => apply_extensions(&mut projection, data),
        },
        "ui/notification" => {
            add_notification(
                &mut projection,
                object_at(data, &["notification"]).unwrap_or(data),
                fallback_id,
            );
        }
        "ui/run-error" => {
            let text =
                string_at(data, &["message", "error"]).unwrap_or_else(|| "Run failed".into());
            let duplicate = projection.history.iter().rev().take(4).any(
                |item| matches!(item, HistoryItem::Error { text: existing, .. } if existing == &text),
            );
            if !duplicate {
                projection.history.push(HistoryItem::Error {
                    id: fallback_id,
                    text: text.clone(),
                });
            }
            projection.state.last_error = Some(text);
        }
        "llm/model-selected" => {
            if let Ok(model) = serde_json::from_value::<Model>(Value::Object(data.clone())) {
                projection
                    .models
                    .get_or_insert_with(ModelList::default)
                    .current = Some(model);
            }
        }
        "queue/changed" | "turn/queue" => {
            projection.queue = normalize_queue(value_at(data, &["queue", "items"]))
        }
        "context/compacted" => projection.history.push(HistoryItem::Info {
            id: fallback_id,
            text: "Context compacted".into(),
        }),
        "context/compaction-fallback" => projection.history.push(HistoryItem::Info {
            id: fallback_id,
            text: "Context compaction fallback".into(),
        }),
        _ => {}
    }
    if let Some(seq) = seq {
        projection.cursor.sequence = projection.cursor.sequence.max(seq);
    }
    projection
}

fn normalize_queue(value: Option<&Value>) -> Vec<QueueItem> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            let raw = value.as_object()?;
            let message = string_at(raw, &["message"])?;
            let kind = string_at(raw, &["kind"]).unwrap_or_else(|| "follow-up".into());
            let id = string_at(raw, &["id"])
                .unwrap_or_else(|| format!("{}:{}:{}", kind, message, index));
            Some(QueueItem { id, kind, message })
        })
        .collect()
}

fn add_message(projection: &mut UiProjection, data: &Map<String, Value>, id: String) {
    let Some(message) = object_at(data, &["message"]).or(Some(data)) else {
        return;
    };
    let Some(role) = string_at(message, &["role"]) else {
        return;
    };
    let text = content_text(message.get("content"));
    projection.history.retain(|item| {
        item.id() != id
            && !matches!(
                item,
                HistoryItem::Assistant {
                    streaming: true,
                    ..
                }
            )
    });
    match role.as_str() {
        "user" => projection.history.push(HistoryItem::User { id, text }),
        "assistant" => {
            let reasoning = string_at(
                message,
                &["reasoning", "reasoning_content", "reasoning-content"],
            )
            .or_else(|| {
                (!projection.state.partial_reasoning.is_empty())
                    .then(|| projection.state.partial_reasoning.clone())
            });
            if !text.is_empty() || reasoning.is_some() {
                projection.history.push(HistoryItem::Assistant {
                    id,
                    text,
                    reasoning,
                    streaming: false,
                });
            }
            projection.state.partial_assistant.clear();
            projection.state.partial_reasoning.clear();
        }
        _ => {}
    }
}

fn add_tool(
    projection: &mut UiProjection,
    data: &Map<String, Value>,
    id: String,
    run_id: Option<&str>,
) {
    let Some(call_id) = string_at(data, &["call-id", "call_id", "callId"]) else {
        return;
    };
    let batch = string_at(data, &["batch-key", "batch_key", "batchKey"])
        .or_else(|| projection.current_batch.clone())
        .or_else(|| run_id.map(ToOwned::to_owned));
    let tool = ToolCall {
        call_id,
        name: string_at(data, &["name"]).unwrap_or_else(|| "unknown-tool".into()),
        arguments: value_at(data, &["arguments", "args"])
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
        ..ToolCall::default()
    };
    if let Some(HistoryItem::ToolGroup {
        tools, batch_key, ..
    }) = projection.history.last_mut()
        && *batch_key == batch
    {
        if let Some(existing) = tools
            .iter_mut()
            .find(|existing| existing.call_id == tool.call_id)
        {
            if existing.name == "unknown-tool" {
                existing.name = tool.name;
            }
            if existing.arguments.as_object().is_some_and(Map::is_empty) {
                existing.arguments = tool.arguments;
            }
            return;
        }
        tools.push(tool);
        return;
    }
    projection.history.push(HistoryItem::ToolGroup {
        id: format!("tool-group:{id}"),
        tools: vec![tool],
        batch_key: batch,
    });
}

fn find_tool_mut<'a>(
    projection: &'a mut UiProjection,
    data: &Map<String, Value>,
    run_id: Option<&str>,
) -> Option<&'a mut ToolCall> {
    let call_id = string_at(data, &["call-id", "call_id", "callId"])?;
    let batch = string_at(data, &["batch-key", "batch_key", "batchKey"])
        .or_else(|| run_id.map(ToOwned::to_owned));
    for item in projection.history.iter_mut().rev() {
        if let HistoryItem::ToolGroup {
            tools, batch_key, ..
        } = item
        {
            if batch.is_some() && *batch_key != batch {
                continue;
            }
            if let Some(tool) = tools.iter_mut().rev().find(|tool| tool.call_id == call_id) {
                return Some(tool);
            }
        }
    }
    None
}

fn update_tool_status(
    projection: &mut UiProjection,
    data: &Map<String, Value>,
    status: ToolStatus,
    run_id: Option<&str>,
) {
    if find_tool_mut(projection, data, run_id).is_none() {
        add_tool(
            projection,
            data,
            format!("live-{}", projection.history.len()),
            run_id,
        );
    }
    if let Some(tool) = find_tool_mut(projection, data, run_id)
        && !tool.status.terminal()
    {
        tool.status = status;
        if status == ToolStatus::Running {
            tool.execution_started_ms = tool
                .execution_started_ms
                .or_else(|| u64_at(data, &["started-at", "started_at", "startedAt"]))
                .or_else(|| {
                    Some(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    )
                });
        }
    }
}

fn finish_tool(projection: &mut UiProjection, data: &Map<String, Value>, run_id: Option<&str>) {
    if find_tool_mut(projection, data, run_id).is_none() {
        add_tool(
            projection,
            data,
            format!("result-{}", projection.history.len()),
            run_id,
        );
    }
    let explicit = string_at(data, &["status"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    let cancelled = value_at(data, &["cancelled", "canceled"])
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || matches!(explicit.as_str(), "cancelled" | "canceled");
    let ok = value_at(data, &["ok"])
        .and_then(Value::as_bool)
        .unwrap_or(explicit != "error");
    if let Some(tool) = find_tool_mut(projection, data, run_id) {
        tool.status = if cancelled {
            ToolStatus::Canceled
        } else if ok {
            ToolStatus::Success
        } else {
            ToolStatus::Error
        };
        tool.result = Some(ToolResult {
            ok,
            cancelled,
            content: content_text(value_at(data, &["content", "result", "output", "details"])),
            error: string_at(data, &["error", "message"]),
            duration_ms: u64_at(data, &["duration-ms", "duration_ms", "durationMs"]),
        });
    }
}

fn terminalize_open_tools(projection: &mut UiProjection, reason: &str) {
    for item in &mut projection.history {
        if let HistoryItem::ToolGroup { tools, .. } = item {
            for tool in tools.iter_mut().filter(|tool| !tool.status.terminal()) {
                tool.status = ToolStatus::Canceled;
                if tool.result.is_none() {
                    tool.result = Some(ToolResult {
                        cancelled: true,
                        error: Some(reason.into()),
                        ..ToolResult::default()
                    });
                }
            }
        }
    }
}

fn apply_extensions(projection: &mut UiProjection, data: &Map<String, Value>) {
    let snapshot = object_at(data, &["snapshot"]).unwrap_or(data);
    let registries = object_at(snapshot, &["registries"]).unwrap_or(snapshot);
    projection.theme = string_at(snapshot, &["theme"]).or_else(|| projection.theme.clone());
    projection.statuses = object_at(registries, &["statuses"])
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    projection.widgets = object_at(registries, &["widgets"])
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    projection.shortcuts = object_at(registries, &["shortcuts"])
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeMap<_, _>>();
}

fn add_notification(
    projection: &mut UiProjection,
    source: &Map<String, Value>,
    fallback_id: String,
) {
    let notification = Notification {
        id: string_at(source, &["id"]).unwrap_or(fallback_id),
        text: string_at(source, &["text", "message"]).unwrap_or_else(|| "Notification".into()),
        level: string_at(source, &["level"]).unwrap_or_else(|| "info".into()),
    };
    projection
        .notifications
        .retain(|item| item.id != notification.id);
    projection.notifications.push(notification);
    if projection.notifications.len() > 20 {
        projection.notifications.remove(0);
    }
}

fn sync_streaming(projection: &mut UiProjection) {
    projection.history.retain(|item| {
        !matches!(
            item,
            HistoryItem::Assistant {
                streaming: true,
                ..
            }
        )
    });
    if projection.state.phase == "model"
        && (!projection.state.partial_assistant.is_empty()
            || !projection.state.partial_reasoning.is_empty())
    {
        projection.history.push(HistoryItem::Assistant {
            id: format!(
                "stream:{}",
                projection.state.run_id.as_deref().unwrap_or("active")
            ),
            text: projection.state.partial_assistant.clone(),
            reasoning: (!projection.state.partial_reasoning.is_empty())
                .then(|| projection.state.partial_reasoning.clone()),
            streaming: true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_and_live_tool_events_share_a_batch() {
        let snapshot: Snapshot = serde_json::from_value(json!({
            "session_id":"s", "cursor":1, "state":{"phase":"idle"},
            "events":[
                {"id":"u","seq":1,"type":"message","data":{"message":{"role":"user","content":"hello"}}}
            ]
        })).unwrap();
        let mut p = from_snapshot(snapshot);
        for (event, data) in [
            ("step/start", json!({"step":1})),
            (
                "tool/call",
                json!({"call-id":"r","name":"read","arguments":{"path":"README.md"}}),
            ),
            ("tool.execution/start", json!({"call-id":"r","name":"read"})),
            (
                "tool/result",
                json!({"call-id":"r","name":"read","ok":true,"content":"done"}),
            ),
        ] {
            p = apply_envelope(
                p,
                &serde_json::from_value(json!({"type":"event","event":event,"data":data})).unwrap(),
            );
        }
        assert!(matches!(&p.history[0], HistoryItem::User { text, .. } if text == "hello"));
        assert!(
            matches!(&p.history[1], HistoryItem::ToolGroup { tools, .. } if tools[0].status == ToolStatus::Success)
        );
    }

    #[test]
    fn duplicate_durable_event_is_ignored() {
        let p = UiProjection::default();
        let envelope: Envelope = serde_json::from_value(json!({
            "type":"event", "event_id":"same", "event":"message",
            "data":{"message":{"role":"user","content":"once"}}
        }))
        .unwrap();
        let p = apply_envelope(apply_envelope(p, &envelope), &envelope);
        assert_eq!(p.history.len(), 1);
    }

    #[test]
    fn extension_notifications_do_not_replace_registered_slots() {
        let mut p = UiProjection::default();
        p.statuses.insert("lsp".into(), json!({"value":"ready"}));
        let envelope: Envelope = serde_json::from_value(json!({
            "type":"event", "event":"ui/extensions",
            "data":{"kind":"notification","notification":{"id":"n1","text":"done","level":"info"}}
        }))
        .unwrap();
        let p = apply_envelope(p, &envelope);
        assert_eq!(p.notifications[0].text, "done");
        assert!(p.statuses.contains_key("lsp"));
    }

    #[test]
    fn snapshot_ids_prevent_buffered_event_replay() {
        let snapshot: Snapshot = serde_json::from_value(json!({
            "events":[{"id":"same","seq":1,"type":"message","data":{"message":{"role":"user","content":"once"}}}]
        }))
        .unwrap();
        let envelope: Envelope = serde_json::from_value(json!({
            "type":"event", "event_id":"same", "event":"message",
            "data":{"message":{"role":"user","content":"twice"}}
        }))
        .unwrap();
        let projection = apply_envelope(from_snapshot(snapshot), &envelope);
        assert_eq!(projection.history.len(), 1);
        assert!(matches!(&projection.history[0], HistoryItem::User { text, .. } if text == "once"));
    }

    #[test]
    fn stream_deltas_project_and_idle_terminalizes_abandoned_tools() {
        let mut projection = UiProjection::default();
        projection.state.phase = "model".into();
        for (event, data) in [
            (
                "llm/stream",
                json!({"type":"text/delta","delta":"streamed"}),
            ),
            (
                "tool.execution/start",
                json!({"call-id":"open","name":"exec_command"}),
            ),
        ] {
            projection = apply_envelope(
                projection,
                &serde_json::from_value(json!({"type":"event","event":event,"data":data})).unwrap(),
            );
        }
        assert!(projection.history.iter().any(
            |item| matches!(item, HistoryItem::Assistant { text, streaming: true, .. } if text == "streamed")
        ));
        projection = apply_envelope(
            projection,
            &serde_json::from_value(json!({
                "type":"event", "event":"agent/state", "data":{"phase":"idle"}
            }))
            .unwrap(),
        );
        assert!(projection.history.iter().any(|item| {
            matches!(item, HistoryItem::ToolGroup { tools, .. } if tools[0].status == ToolStatus::Canceled)
        }));
    }

    #[test]
    fn duplicate_tool_call_in_one_batch_updates_in_place() {
        let mut projection = UiProjection {
            current_batch: Some("batch".into()),
            ..UiProjection::default()
        };
        for name in ["unknown-tool", "read"] {
            projection = apply_envelope(
                projection,
                &serde_json::from_value(json!({
                    "type":"event", "event":"tool/call",
                    "data":{"call-id":"same","name":name,"arguments":{"path":"README.md"}}
                }))
                .unwrap(),
            );
        }
        assert!(
            matches!(&projection.history[0], HistoryItem::ToolGroup { tools, .. } if tools.len() == 1 && tools[0].name == "read")
        );
    }
}
