# Plugin lifecycle and final tool contracts

The host remains a Babashka/Clojure kernel. These changes strengthen the existing
in-process contract; they do not turn namespace plugins into a security sandbox.
Trusted plugins can still run host code. Downloaded data-only packages and
Blueprints keep their existing capability restrictions.

## Instances and registration

Each plugin ID has a monotonically increasing generation and a phase:
`starting → active → stopping → stopped`. A retained plugin context never acquires
a newer generation implicitly. Startup publishes registrations and their cleanup
in the same atom transaction. Starting registrations are hidden from unrelated
callers until activation. The startup lease covers `start`, the returned disposer,
provision checks and activation, so stopping cannot finish before a late startup
resource joins cleanup.

Use `plugin/load-plugin!` for namespace plugins. `kernel/plugin-context` is useful
for a first implicit local owner; a stopped owner requires an explicit new
`kernel/begin-plugin!`. Stale contexts cannot register services, tools, commands,
observers or interceptors. `track-effect!` compensates a resource already allocated
by a secondary registry when its late cleanup registration is rejected; compensation
has a separate observable receipt and is not retried automatically.

## Dependencies and stopping

Declared `:requires` bindings record the service registration, provider and
generation. Startup checks them atomically. Provider withdrawal closes admission
for the transitive consumer domain in the same transaction. Consumers withdraw
their public capabilities and clean up before their providers. Calls already
admitted and same-thread cleanup can use their original dependency bindings,
including a retired service needed to write a final outcome. New consumers use
the new binding; nested calls do not inherit an unrelated caller's old service.

A suspended consumer restarts using its original descriptor and configuration
when every required service is available and cleanup completed. An explicit stop
clears the desired state. Generation/desired checks at restart admission prevent
an already selected automatic recovery from overriding that stop. Missing
optional services are not inferred as declared dependencies.

Shutdown has three stages:

1. Close public admission and run `kernel/track-stop!` signals. A stopper closes
   local admission and cancels/wakes blocked operations. It must not wait for a
   lifecycle drain before issuing cancellation.
2. Wait for admitted synchronous calls and dependent consumer cleanup.
3. Run tracked effects in reverse order and await returned Clojure
   futures/promises/delays. Only then publish the final receipt.

`dispose-plugin!` returns a receipt with plugin ID, generation and status. The
wait defaults to 5000 ms; `{:timeout-ms n}` accepts 1–60000 ms. `complete` means
cleanup finished; `failed` records disposer failures; `blocked` records an
incomplete consumer. `timeout` means cleanup is still running, and a call stopping
its own dependency domain returns `pending` so it can exit. Runtime inspection
exposes phases, call counts and final receipts. `dispose-all!` reports aggregate
`incomplete` whenever any child did not complete.

A timeout does not kill arbitrary Clojure code or make external effects known.
The finalizer can complete later; a permanently blocked or failed generation
cannot be replaced in place. Inspect the outcome and use worker recovery when
needed. Do not replay an unknown external mutation. Package and runtime-lab
management refuse to report stopped/replaced when the receipt is incomplete.

Service/tool/command/hook functions hold owner leases. Secondary provider and
manual RPC callbacks use `kernel/wrap-plugin-value` to retain their actual owner.
Asynchronous work must explicitly acquire its lease in the executing thread and
provide a stop signal; dynamic bindings inherited by a future do not grant its
parent thread's lease. `kernel/inspection` is an explicit exception for immutable
or terminal readback after stopping (currently retained job listing); do not use
it for mutations or blocking work.

## Final tool boundary

`qi.tool-contract` is shared by model calls and terminal/Office manual execution.
Preparation takes an immutable JSON snapshot of arguments and approval targets,
validates arguments, runs the existing approval middleware, then runs final
guards. Calls retain the selected tool registration and original execution
identity, including call ID, token, scope, cancellation token and callback.
Execute middleware cannot replace that identity or invoke the body twice.

Final guards can only abstain with `nil` or deny with `{:reason "..."}`. Invalid
results and exceptions deny. The policy guard rechecks deny rules and trust and
uses a private receipt bound to the exact approved invocation and approval
provider. It does not ask for approval again. Guards, policy and tool generations
are checked again immediately before the body; changing them invalidates the
prepared call. Planning and child tool boundaries also register final guards.

A body or middleware failure cannot become success in a later hook. An execute
hook may short-circuit with a failure/block, but cannot claim successful execution
without the body. Output is snapshotted and checked before renderer/details/image
callbacks, and again after post hooks. Live end, durable result and model tool
message use the existing single-terminal completion path.

Canonical data permits immutable JSON primitives, keyword names, maps with unique
JSON keys and sequences copied into vectors; it rejects host objects, mutable
numbers, nonfinite numbers, ratios, duplicate encoded keys and excessive
structure (64 levels / 100000 nodes). Namespaced keyword keys retain their JSON
namespace. A declared `:output-schema` adds validation using `qi.schema`'s existing
supported subset. Legacy tools without an output schema receive canonical-data
validation only; the host does not invent a schema or claim full JSON-Schema
coverage. Error values and presentation fields must also be canonical data.
Blueprints validate output before committing draft state.

Manual terminal close/interrupt retain their cleanup exemption, and read does
not gain a second approval. Office keeps its generated-output identity check and
reports uncertainty after a started conversion whose result cannot be confirmed.

Regression coverage lives in `test/qi/plugin_contract_test.clj` alongside the
existing runtime, desktop, terminal, jobs, orchestration and package suites.
Native/offline tests do not establish real provider or production desktop results.
