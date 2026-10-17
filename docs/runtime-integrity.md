# Run outcomes and context integrity

Every admitted native run has a `run-id`, a durable `agent/run/start`, and one
`agent/run/end`. The existing live `agent.run/end` notification carries the same
terminal fields. Child registry runs have separate `subagent/run/start` and
`subagent/run/end` records; `execution-run-id` links a registry result to the
native child run when available. Queued child messages keep the active run ID.

| Status | Meaning | Legacy `stop-reason` |
| --- | --- | --- |
| `completed` | Execution ended normally | `completed` |
| `failed` | Provider, context, step budget, or policy failure | `error` |
| `cancelled` | User cancellation or explicit stop | `aborted` |
| `uncertain` | An interrupted or otherwise unconfirmed outcome | `restored` |

`reason` distinguishes `step-budget`, `tool-terminated`, `output-limit`, provider
errors, and context failures. Successful execution defaults to
`verification: not-run`; it does not certify a code change or its acceptance
tests. `usage` carries reported usage accumulated from main-loop responses, not
a complete billing ledger for compaction and failed requests. Recovered orphan
runs have unknown usage and step counts. Legacy logs without run envelopes
remain readable and are not assigned invented outcomes.

`request-usage` adds a separate logical-request summary: known input/output
tokens, request count, unknown request count, and token completeness. It includes
compaction and failed requests by request ID, and never substitutes zero for an
unknown invoice. Main/compaction events carry native/root run IDs; summary
fragments also carry a compaction ID and chunk index. Manual compaction without
an active run receives an independent operation ID.

Optional runtime `max-model-requests` and `max-wall-ms` cover all logical calls
through `qi.generation`, including retries, summary fragments and inherited child
budgets. Exhaustion refuses the next call with `request-budget` or `wall-budget`;
an interrupted summary preserves the original history. These are admission
limits; the maintenance controller additionally kills the outer container at its
deadline. Its dedicated profile uses 64 requests and 35 minutes for implementation.
See [unattended maintenance](unattended-maintenance.md) for host-enforced cost
reservation and the distinction between a configured price ceiling and billing.

Child failures, cancellation, and uncertainty propagate to workflow nodes.
Failed/cancelled dependencies are skipped; an uncertain child suspends the
workflow as uncertain. Contradictory `completed` plus `error` is a failure.
Late results cannot overwrite a newer run or resurrect a stopped child.

## Request budgets

The context manager's `budget!` service estimates the system prompt, tool
schemas, messages, request options, and resolved attachments, with an explicit
output reserve. The selected provider or per-request provider override supplies
the context window. Provider aliases are resolved and the provider ID is pinned
for compaction and dispatch. The configured context window remains a fallback
for providers that do not declare one.

The runtime checks again after request middleware and attachment resolution.
It records `context/budget` for dispatched main-loop requests. `context.status`
uses the same estimator and reports the last dispatched budget during a run
(`basis: last-request`) and the next-request estimate while idle. It exposes
`reserve_tokens`, `input_limit`, `option_tokens`, and `fits` alongside the
existing fields. These are estimates, not provider tokenizer measurements;
provider-specific wire formatting can differ.

## Compaction commits

Automatic compaction keeps the latest user instruction and its following
messages verbatim. The session's safe split keeps tool calls with their results.
The discarded prefix is rendered in full, including tool IDs and arguments.
Images become explicit omission markers; their original bytes remain in the
append-only history and must be recaptured when needed by the model.

`max-source-chars` (default 48000) now limits each summary request, not the
history being covered. Each fragment must fit its own request budget. A maximum
of `max-summary-calls` (default 64) bounds one compaction attempt. Oversized
messages may span fragments; UTF-16 surrogate pairs are never split.

All fragments must return complete, nonempty text. Their summaries are combined
without another truncation. The checkpoint includes `coverage` with source
character ranges, SHA-256 hashes, message count, and image omission metadata.
Coverage proves which text was submitted; it does not prove semantic fidelity
of an LLM summary or preserve pixel content.

Before committing, the session rechecks its snapshot, cancellation, and the
replacement's full request budget under its write lock. Failed/incomplete
summaries and oversized replacements leave the original history active.
Manual deterministic compaction returns `summary-too-large` rather than
truncating a prefix. All original message events remain recoverable.

An unfit immutable prefix or current instruction, exhausted compaction call
limit, or unavailable safe split returns structured `code: context_unfit` with
`retryable: false`. Summary generation failure returns `reason: summary-failed`.
Provider overflow retries at most once, and only after a committed compaction.
A single long current turn can therefore stop instead of silently compressing
its exact instruction and current tool work; use a larger-window provider or
start a new explicit task with the needed state.

## Regression checks

Run `bb test` for backend coverage, or `npm test` for the complete existing
typecheck, web host/UI, ACP, TUI, backend, and evaluation test suites.

`test/qi/run_outcome_test.clj` covers durable/live terminal outcomes, recovery,
child results, run identities, and workflow propagation.
`test/qi/context_integrity_test.clj` covers late constraints past 48K, complete
source coverage, failed fragments, unfit requests, model selection, middleware,
and shared UI budgets. Existing recovery tests cover stale summaries,
cancellation, tool batch integrity, and late child watchers.
