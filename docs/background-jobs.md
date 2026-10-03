# Background shell jobs

The coding `bash` tool accepts `run_in_background: true`. The tool returns a
session-owned job ID immediately; the command continues through the same
ExecutionWorld provider, sandbox, cwd validation, process timeout and disk-output
limits as foreground commands. The existing bash trust and approval policy still
runs before any background job is reserved or launched.

```json
{"command":"npm test","run_in_background":true,"timeout_ms":300000}
```

Use `job_list` to inspect retained jobs, `job_output` to read progress, and
`job_kill` to cancel a job. Job IDs are opaque and only work in their originating
session. A job from a different session cannot be read or killed by guessing an
OS process ID.

```json
{"job_id":"returned job ID","offset":0,"limit":20000,"wait_ms":1000}
```

`job_output` combines stdout and stderr in callback arrival order. `offset` is a
zero-based character cursor (UTF-16 code units), not a line or byte offset. Pass
the returned `next-offset` on the next call. `end-offset` is the current total
output cursor. A full retention buffer discards its oldest characters;
`available-offset`, `output-discarded?` and `discarded-chars` make that loss
explicit. `truncated` means more retained output is available after this page.
If no new output arrives before the requested wait expires, `wait-timed-out` is
true. Waiting is cancellable and ends early on new output or completion.

Statuses are `queued`, `running`, `cancelling`, `completed`, `failed` and
`cancelled`. A nonzero shell exit is `failed`, with its exit code preserved.
Timeouts, startup failures and output-limit failures retain their error message.
`job_kill` is idempotent; `cancelling` means the process has received cancellation
and its worker is still releasing resources. Continue reading the job to observe
its terminal state.

## Configuration

Load `qi.plugins.jobs` after the ExecutionWorld provider. The session store is
optional and looked up when an event occurs. The coding tools find the job service
at execution time, so either order between coding and jobs plugins works.

```clojure
{:ns qi.plugins.jobs
 :config {:max-running 4
          :max-retained 64
          :max-output-chars 200000
          :max-read-chars 50000
          :max-wait-ms 30000
          :shutdown-wait-ms 3000
          :timeout-ms 300000}}
```

All limits must be positive integers, and `max-retained` must be at least
`max-running`. By default, background commands have a five-minute timeout capped
at the local world's `max-timeout-ms`. Explicit `timeout_ms` still cannot exceed
that world limit. A higher limit requires changing the ExecutionWorld
configuration as well. Foreground bash keeps its existing default timeout.

Only terminal jobs are expired when retention fills. Active jobs count toward
the concurrency limit; requests above that limit fail instead of creating an
unbounded queue. Output buffers, page size and wait duration are all bounded.
The ExecutionWorld still bounds stdout and stderr spool files independently and
retains `full-output-path` for normal results whose foreground preview was
truncated, subject to its existing output-file retention policy.

## Cancellation, notifications and lifecycle

An originating run's cancellation token is linked to each background job until it
finishes. Normal completion of that run does not cancel its background jobs.
Unloading the jobs plugin rejects new starts, cancels active jobs, and waits for
worker cleanup within one shared shutdown deadline. Each local cancellation
terminates the shell and known descendants before forcing survivors to exit.
The ExecutionWorld also bounds output draining by the command deadline, including
when a shell exits while a child still holds inherited pipes. Spool files are
removed on success, failure, cancellation and interruption.

Kernel events `:job/started` and `:job/completed` include the job ID, originating
call ID, status, exit/error summary and session ID when available. With a session
store, the same data is appended as `job/started` and `job/completed` and emitted
through `:session/event`, so the existing event stream can show completion after
the original bash tool has returned. It does not automatically submit another
model turn or rerun a command.

Jobs are owned by the current worker and do not survive worker exit or plugin
unload. Session completion records survive when the session store is persistent;
they are history, not resumable process handles. This is not a terminal emulator:
there is no interactive stdin, PTY, persistent shell state, detached daemon
recovery or process reattachment. Commands intentionally daemonizing outside the
observed process tree are outside this service's lifecycle contract.

Without the jobs plugin, ordinary foreground `bash` remains compatible.
Requesting `run_in_background: true` reports that the plugin is required instead
of silently executing in the foreground or outside the ExecutionWorld.

## Provider contract

The plugin provides `:execution/jobs` with:

* `:start!` — `(spawn-args execution)`, returns a reserved job descriptor.
* `:list` — `()`, returns retained descriptors, newest first.
* `:output` — `({:job-id id :offset n :limit n :wait-ms n} execution)`.
* `:kill!` — `(job-id)`, requests cancellation and returns current status.
* `:close!` — `()`, idempotently closes the manager; reports remaining workers.
* `:limits` — the effective buffer, concurrency, wait and timeout limits.

Providers receive the regular `:spawn!` request with a dedicated `:cancel-token`,
an `:on-update` callback and `:stream-output? true`. Local ExecutionWorld streams
up to its existing disk-output limit for this option; ordinary foreground
callbacks remain bounded by their original preview limit. A custom world that
only supplies final output must implement streaming callbacks before it can
provide live `job_output` progress.

Offline verification is in `test/qi/jobs_test.clj`, covering cursor loss,
concurrency, retention, cancellation before/after launch, bounded waits, session
events, legacy bash, process-tree cleanup, output limits and inherited-pipe
timeouts. Tests use mocks or isolated temporary processes; no daemon or real
model is required.
