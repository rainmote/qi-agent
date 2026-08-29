---
name: creating-agent-presets
description: Create, change, validate, or remove a DAO Agent preset from Creator mode, including deciding whether a capability belongs in a per-Session preset or the shared host profile.
---

# Create DAO Agent presets

Use this workflow whenever the user asks to create or change an Agent mode.

## Boundaries

- Never modify or delete a `system` preset. Copy it first.
- A preset owns one Session's contributed tools, prompt, persona, and context policy.
- Cross-Session registries, persistence, credentials, provider routing, sandbox, approval, and daemon services belong to the host profile, not a user preset.
- User presets may reference only built-in `agent.*` plugin namespaces. Do not use source evaluation, `load-string`, arbitrary paths, or guessed namespaces. Session-local EDN Blueprints are a separate runtime experiment and are not plugin namespaces in a Preset.
- A running Session uses an immutable configuration snapshot. Preset edits affect only a newly created Session.

## Workflow

1. Call `preset_guide` and `preset_inspect` with `action: "list"`.
2. Read the most suitable healthy base with `preset_inspect` `action: "read"`. Prefer `standard` for a full coding Agent; use `creator` only when the new mode itself needs authoring tools.
3. Call `preset_author` `action: "copy"` with a new lowercase id and a clear display name.
4. Edit the returned user copy only. Send the complete `agent.edn` EDN text through `preset_author` `action: "update"`; include name or description when they need changing.
5. Keep plugin order dependency-correct. Providers and registries must precede consumers. Do not duplicate plugin ids.
6. Call `preset_inspect` `action: "validate"` after the final update.
7. Report the new preset id and ask the user to create a new Session with it. Do not imply the current Session changed modes.

Use `runtime_inspect` to verify facts about the current live topology. A successful runtime experiment does not persist into a preset; encode an audited built-in plugin row in the copied `agent.edn` if the user wants it in future Sessions. A runtime EDN Blueprint remains session-local; use the `creating-runtime-blueprints` skill for that workflow.
