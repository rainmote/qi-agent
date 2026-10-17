# Run outcomes and context integrity

Actual CLI entries (including daemon-backed workers) stamp new session events
with `sample_kind`, `source_sha`, `profile_sha256` and `session_id`. A mock profile
is fixture traffic; CI is labelled ci. `QI_AGENT_SAMPLE_KIND` may explicitly mark
fixture/ci/unclassified traffic; it cannot turn a mock profile into production.
Direct plugin boots without entry provenance remain unclassified. These labels
are provenance conventions, not an authentication or billing guarantee.

The source SHA is emitted only for a clean source checkout; modified tracked
files, untracked source/plugins and unavailable Git evidence keep it null. The
profile fingerprint covers the effective entry configuration and provider/mode
overrides, without persisting its text or credentials. Every resumed entry adds
a `session/source` marker; earlier records retain their original classification.
This does not retroactively label historical tests as production.

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

`request-usage` is explicitly `scope: session-local` with `request-scope: logical-requests`: known input/output
tokens, request count, unknown request count, and token completeness. It includes
compaction and failed requests by request ID, and never substitutes zero for an
unknown invoice. Main/compaction events carry native/root run IDs; summary
fragments also carry a compaction ID and chunk index. Manual compaction without
an active run receives an independent operation ID.

`root-request-usage` is a separate `root-tree` subtotal. Each native run persists
`usage/tree-run` facts in its owning root session; child requests write
`usage/child-request` before dispatch and after settlement to that same index.
Provider admission is also recorded before launch and linked to the child's
native execution run and host-bound child agent identity on completion. The index stores identities, status and usage,
not child prompts or outputs. It uses the parent log's durable sequence and never
scans unrelated session directories. Replayed starts cannot replace terminal facts;
request IDs with source session IDs deduplicate repeated delivery. Reloading the
parent log reconstructs the same totals.

Coverage lists expected/observed sessions, pending native children and unknown
provider runs. Pending, legacy-unindexed or opaque external-provider coverage cannot
claim complete token usage, even when the known request subtotal is complete.
Independent manual compaction has its own operation identity and is excluded.
Parent-index persistence failure refuses the child's next provider dispatch; an
already sent request with a missing settlement stays unknown. Neither subtotal is
an invoice: complete cost remains null and accounting-complete remains false.

Optional runtime `max-model-requests` and `max-wall-ms` cover all logical calls
through `qi.generation`, including retries, summary fragments and inherited child
budgets. Exhaustion refuses the next call with `request-budget` or `wall-budget`;
an interrupted summary preserves the original history. These are admission
limits; the maintenance controller additionally kills the outer container at its
deadline. Its dedicated profile uses 64 requests and 35 minutes for implementation.
See [unattended maintenance](unattended-maintenance.md) for host-enforced cost
reservation and the distinction between a configured price ceiling and billing.

The Rust resident worker proxy additionally supports the explicit host environment
`QI_AGENT_RUN_WALL_MS` (positive integer milliseconds, unset by default). It starts
a monotonic timer on each observed native `agent/run/start`; duplicate starts do
not extend it and ends strictly before the deadline disarm it. Equality/late ends
cannot win the deadline race. Each start/end atomically saves a private
`<descriptor>.deadlines.json` with worker, generation, native run/session and
wall-clock `started_at_ms/deadline_at_ms` identities. Enforcement uses monotonic
time; wall timestamps are diagnostic. The proxy survives daemon restarts, so a
replacement daemon does not reset the deadline.

Expiry enters `cancelling` and dispatches cooperative root/child aborts on a
separate RPC lane, then kills the owned Babashka process
group even when a model or tool ignores cancellation. The earliest root/child
expiry retires the shared worker tree. Private socket authentication cannot block
the timer, and output from an older generation cannot arm or complete a new run.
Invalid settings stop the proxy before it starts a worker.
`QI_AGENT_RUN_CANCEL_GRACE_MS` selects 1–1000 ms (default 250) between expiry and
retirement. A blocked RPC pipe cannot stall that timer. Further mutations are
refused during cancellation; read-only snapshots fence matching outcomes as
uncertain. The proxy retains its session lease until its child has exited.

Before signalling, the proxy writes a private `<descriptor>.watchdog.json` receipt
(with the `.json` extension replaced), then records the signal result, run IDs,
generation, deadlines, cancellation request, grace, limit and `uncertain` / `not-run`. Failure to persist diagnostics is
logged and does not prevent termination. Normal recovery closes interrupted
native runs as `uncertain/restored` and does not replay them. In a replacement
generation the runtime checks the host-selected private receipt, matching worker,
older generation, session and an existing native start. It appends an explicit
`host-arbitrated` uncertain/hard-wall-timeout correction before admitting work,
even if the old worker persisted a late completed terminal. The original fact
remains in the log; the corrective end supersedes it and is not appended again.
Malformed/oversized host receipts block recovery. The exit notification
also carries `hard-wall-timeout`. This limits local execution, not remote billing
or remote side effects already dispatched. It covers native runs observed by the
Rust proxy, not direct `bb` calls or arbitrary detached processes that escape the
worker process group; tool-group guards and outer container/PID limits remain
separate. Host scheduling and storage delays can add latency to enforcement.


The default loop stops after three unchanged read results, including short cycles
in a bounded eight-batch fingerprint window, with `failed/no-progress`. The last
three call IDs, result fingerprints and evidence gap are retained. Arguments and
canonical results ignore IDs and timing. Successful sequential mutations and
consumed steering/follow-ups reset tracking; changing results do not accumulate
identical fingerprints. Explicit polling tools retain their separate finite cap
of 32 consecutive unchanged batches. Configuration can narrow these limits.

The terminal includes one `diagnostic-plan`: a read-only suggestion to inspect a
different source/revision, with the original run/root IDs, request count/limit and
deadline. This is data for inspection, never an automatic dispatch or a fresh
budget. An explicitly uncertain action stops immediately with a reconciliation-only
suggestion; it is not dispatched a second time. Cancellation still wins and
keeps its own terminal. No retry, replay, rollback or directory reset is added.
The bounded window does not identify arbitrary semantic loops or completion.

Read-only batches use at most four worker futures by default, configurable with
`max-parallel-tools`. Approval stays serial, mixed sequential batches stay serial,
and durable tool results retain model order. Cancellation closes waiting slots
before their bodies can start; a non-cooperative running body can still outlive
its cancelled result.

Web and TUI project the same native outcomes into one history row per run ID,
merging associated errors and retaining outcomes across snapshots and replay.
`completed` plus `not-run` reads “运行完成 · 尚未验收”; restored uncertainty reads
“结果未确认 · 需要核对”. Only explicit verification evidence can display a passed
verification label. Legacy errors without an identity remain ordinary errors.

Session response detail (`short`, `auto`, `detailed`) is persisted as
`session/preferences`, read through `session.preferences` and changed through
`session.preferences.set`. The next request's system prompt includes the selected
presentation preference, including an explicit requirement to disclose missing,
failed, partial or unknown verification. Already dispatched requests are unchanged.
Preferences survive clear and worker recovery within the same session; they do
not change tools, trust, policy, budgets, or acceptance state.

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

Semantic compaction emits durable `context/compaction` facts with `started`,
`progress`, and `completed`/`failed`/`cancelled` states, native run or independent
operation identity, compaction ID, completed/total chunks and elapsed time.
They do not become model messages. Active native runs project them as
`compacting`; Web/TUI show “整理上下文 n/N” and close the progress on every outcome.
Queue injection persists `queue/consumed` with the original item ID. Web steering
is labelled “下一步引导” and acknowledges the next model-request boundary.

An unfit immutable prefix or current instruction, exhausted compaction call
limit, or unavailable safe split returns structured `code: context_unfit` with
`retryable: false`. Summary generation failure returns `reason: summary-failed`.
Provider overflow retries at most once, and only after a committed compaction.
A single long current turn can therefore stop instead of silently compressing
its exact instruction and current tool work; use a larger-window provider or
start a new explicit task with the needed state.

## Regression checks

Read-only telemetry can be exported without starting a daemon or a schedule:

```sh
node maintenance/report-telemetry.mjs \
  --from 2026-10-14T00:00:00+08:00 --to 2026-10-15T00:00:00+08:00 \
  --timezone Asia/Singapore --session-root /absolute/workspace/.qi-agent/sessions
```

Roots are explicit and repeatable; timestamps require offsets and the interval
is `[from,to)`. Traffic is grouped by explicit `sample_kind`/`sample-kind` on a
session/event, or `--sample-kind production|fixture|ci|unclassified`; the default
is unclassified. Unlabelled historical logs are never inferred as production.
No admitted or terminal runs means `no_samples` and null rates. Missing sources,
corrupt lines, invalid timestamps, unreadable files and skipped symlinks remain
visible with `status: incomplete`. Logical requests deduplicate by session and
request ID; known token subtotals and unknown request counts remain separate,
and complete invoice totals stay null. Cross-window starts are considered when
detecting orphan terminal events; terminal coverage uses only admitted runs.

Run `bb test` for backend coverage, or `npm test` for the complete existing
typecheck, web host/UI, ACP, TUI, backend, and evaluation test suites.

`test/qi/run_outcome_test.clj` covers durable/live terminal outcomes, recovery,
child results, run identities, and workflow propagation.
`test/qi/context_integrity_test.clj` covers late constraints past 48K, complete
source coverage, failed fragments, unfit requests, model selection, middleware,
and shared UI budgets. Existing recovery tests cover stale summaries,
cancellation, tool batch integrity, and late child watchers.
