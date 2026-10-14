# Durable schedules and goals

The daemon owns scheduling, state, delivery identities and continuation budgets in its SQLite database. Web and TUI clients may disconnect without cancelling these tasks. All public mutations require the current agent controller. A schedule or goal belongs to its agent; another agent cannot mutate it.

## Schedules

Use `schedule.add` with `prompt` and exactly one time selector:

| Selector | Example | Meaning |
| --- | --- | --- |
| `at_ms` | future Unix milliseconds | One occurrence at an absolute instant |
| `delay_ms` | `600000` | One occurrence ten minutes later |
| `every_ms` | `3600000` | Interval after each admitted dispatch, minimum 100 ms |
| `daily` | `"09:30"` | Calendar time every day |
| `weekly` | `"MON,WED,FRI 09:30"` | Calendar time on selected weekdays |
| `expression` | `"30 9 * * MON-FRI"` | Five-field minute/hour/day/month/weekday cron |

Calendar rules use an explicit IANA `timezone`, such as `Asia/Hong_Kong` or `America/New_York`; omission means UTC. Cron supports lists, ranges, steps, month names JAN–DEC, weekday names SUN–SAT, and Sunday as 0 or 7. Restricted day-of-month and day-of-week use standard cron OR semantics. Search is bounded to the next eight years; impossible dates are rejected. At daylight-saving changes, nonexistent wall times are skipped and repeated wall times run at their first occurrence only. Missed recurring ticks are not backfilled.

`schedule.list` returns expression, next timestamp, policy, status and `revision`. `schedule.update`, `schedule.pause`, and `schedule.resume` require `schedule_id` and `expected_revision`. `schedule.cancel` also accepts this check and the Web/model clients always supply it; omission remains supported for legacy callers. A stale revision returns `revision_conflict` and must be refreshed, never blindly retried.

Updates support prompt and time/timezone changes. Active tasks can be paused, paused tasks resumed, and definitively failed tasks explicitly resumed with a fresh retry budget. A one-shot time that elapsed while paused must be edited before resuming. Claimed and uncertain tasks cannot be edited or resumed. Cancellation stops future dispatches and does not interrupt an already admitted turn.

A claimed tick persists its delivery ID before admission. Definite admission failures retry with that same ID and bounded backoff. A lost acknowledgment or interrupted claim becomes `uncertain`, retains its identity and will not replay automatically, including after a daemon restart. Inspect actual session effects, then cancel the old task and explicitly create the appropriate future schedule. Cancelling an in-flight claim cannot be overwritten by its late completion.

A one-shot schedule becomes `completed` after turn admission is acknowledged. Its asynchronous turn may still be persisting messages or running; inspect the run outcome and durable session evidence separately before treating the work as finished or verified.

## Goals

`goal.set` requires `objective` and optionally `max_continuations` (default 3, maximum 20). Creation is explicit user intent; ordinary tasks must not create goals automatically. An unfinished goal prevents silent replacement by another. A public `goal.set` begins its first turn; each successful turn can trigger the next continuation until the budget is exhausted.

`goal.list` and `goal.status` return objective, status, used/maximum continuations, last run/error and revision. `goal.update` changes objective or budget with a mandatory expected revision. `goal.pause`, `goal.resume`, `goal.complete`, and `goal.cancel` manage the lifecycle. Web/model clients supply the revision for every update. Budget updates cannot lower the budget below consumed continuations or raise it above 20. Resuming does not grant additional budget. `uncertain` goals additionally require `reconciled: true` after checking earlier effects. Completion is an explicit verified outcome, never an inference from reaching a budget.

Pausing/cancelling/completing stops future continuations; it does not abort a current turn. Goal stopping is fenced against continuation admission. Late run errors cannot revive a paused or terminal goal. A current turn that survives a pause can be reattached by resume without starting a second turn. Machine-interrupted active or paused goals become uncertain before resuming.

## Model and Web entry points

`qi.plugins.automation` provides `schedule_*` and `goal_*` tools. It requires `:remote/registry` and `:tool/policy`; mutations require project trust. Goal completion, cancellation, resume and changes to objective/budget additionally pass through the normal approval service. Tool descriptions restrict creation and pausing to explicit user requests.

The plugin sends a correlated `automation/request` event to the daemon and receives `automation.resolve` on the private worker channel. Public RPC rejects that response method even for controllers. The daemon takes identity from its authenticated worker connection, rejects child-agent requests, journals each operation, and consumes bridge events before public broadcasting. It never self-connects to its public socket or submits a nested turn. Model-created goals bind to the current daemon-managed run. Standalone non-daemon CLI sessions report automation as unavailable; lost bridge replies report an unknown outcome and are not retried automatically.

The Web `AutomationPanel` accepts a session-scoped RPC callback and offers creation, updates, pause/resume/cancel, goal budgets and explicit uncertain-goal reconciliation. All mutations are disabled for observers. Switching sessions discards stale request results. Task timezone is displayed beside every calendar rule.

## Verification

Offline coverage includes calendar fields and invalid expressions; Hong Kong scheduling; New York DST gaps/overlaps; leap days; revision conflicts; paused database reopen; unknown delivery identity; cancellation versus late claim completion; goal state/budget fences; unavailable/timed-out bridge behavior; and mandatory completion approval. An isolated daemon integration test runs real worker processes with a deterministic mock model, verifies model schedule/goal tools and continuation limits, rejects observer mutations and public response injection, and restarts only its temporary daemon to check durable timezone and pause state. No live model, user daemon, or user schedule is needed.

The bundled database is SQLite 3.53.2 (`rusqlite` 0.40.2 in `Cargo.lock`). The earlier 3.51.1 library could deadlock when daemon threads opened and closed WAL connections concurrently: `goal.list` stopped replying and completed runs could remain running in the database. The regression in `tests/sqlite_wal.rs` exercises 2,000 concurrent connection cycles in a bounded subprocess; a native deadlock produces an explicit assertion failure and the child is reaped. The automation integration client includes RPC identities in transport errors and cleans up only workers owned by its temporary fixture. See the [upstream lock-order fix](https://sqlite.org/forum/info/7497f8f6052ed70a763672edffb414ec6c6834037cf2d7d4e5b486284fcc6b7a) and [WAL-reset fix](https://sqlite.org/releaselog/3_51_3.html).
