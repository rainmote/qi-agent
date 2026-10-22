# Computer use with LCU

qì integrates the [LCU library](https://github.com/amontlabs/lcu) through its
[official shared client](https://github.com/amontlabs/lcu/blob/v0.11.2/adapters/client.mjs).
LCU runs the computer-use runtime supplied by the installed ChatGPT desktop app.
It does not require ChatGPT authentication for desktop control; the selected model
provider has its own authentication requirements.

`qi.plugins.lcu` supplies `computer_js` and `computer_js_reset`. The original tool
schemas, descriptions and initialization instructions reach the model. qì forwards
text, error state and screenshot bytes through its existing tool-result/image
pipeline. The official client owns desktop execution, host-app protection, native
approval semantics and reset cleanup. `turn_ended` and module-loading tools are
host-only and are never registered as model tools.

## Install and enable

Install the official ChatGPT desktop app first. Download the matching LCU release
and SHA-256 sidecar, verify the checksum, then use its installer:

```sh
./scripts/install.sh --runtime-only --yes
```

See the [LCU installation guide](https://github.com/amontlabs/lcu/blob/v0.11.2/docs/INSTALLATION.md)
for platform prerequisites and permissions. qì does not install or upgrade LCU at
startup. Integration was exercised with **LCU 0.11.2**. The installed release must
include `adapters/client.mjs` and its dependencies, `bin/lcu`, and preferably the
installer's `node-path` file.

The default profile includes a **disabled** LCU provider. To enable it, use
[`examples/lcu.edn`](../examples/lcu.edn) or add these entries to your profile after
session, model registry, execution world, trust, approval and policy:

```clojure
{:ns qi.plugins.computer-use}
{:ns qi.plugins.lcu :config {:enabled true :connect-on-start false}}
```

The execution world must explicitly use `:sandbox :none` and the project must be
trusted through the user's trust store. First run with LCU disabled, review
`/trust`, and use `/trust allow` for a project you trust. Desktop actions are not
confined to workspace files. The model must declare and actually support images.
Only one desktop provider may be enabled in a context; Cua Driver remains available
as an alternative in [`computer-use.md`](computer-use.md).

Use a frontend with the existing approval UI, such as the Rust TUI or WebUI's RPC
worker. For an already built Rust frontend:

```sh
apps/tui-rs/target/release/qi-agent --config "$PWD/examples/lcu.edn"
```

Set `OPENAI_API_KEY` for the example, or replace its model provider with your normal
image-capable provider. Existing daemon sessions retain their own profile; check
the actual session configuration when attaching to one.

Native-app consent is separate from tool approval, including under Full Access.
The original approval message is displayed in the existing UI. qì offers Allow
once, Allow for this session when the runtime offers it, and Decline; it does not
offer persistent “always” grants. Without an active prompt UI (including plain
`bb qi-agent --once`), new app approval requests are cancelled, never auto-accepted.
Unsupported elicitation forms also cancel. In explicitly enabled Chrome mode,
the adapter recognizes the exact empty-form `access_browser_origin` contract
from the [LCU 0.11.2 client and fixtures](https://github.com/amontlabs/lcu/blob/v0.11.2/adapters/test/mcp-fixture.mjs).
Only canonical HTTP(S) origins with matching origin metadata are accepted for
prompting. URL challenges, nonempty forms, history access, mixed native/browser
metadata and unknown kinds cancel. Audio remains unsupported.

Site consent is independent of native-app and tool approval, including Full
Access. The original request text and exact origin are shown to the user. An
allow applies to this origin in the current session, workspace and connection;
deny returns the original decline response. Cancellation, UI timeout, stale
answers and missing UI return cancel. Reconnection and other sessions require
fresh decisions. The frontend displays this scope rather than calling it an
allow-once grant.

## Configuration and recovery

| Field | Default | Purpose |
| --- | --- | --- |
| `:enabled` | `false` | Explicit opt-in; disabled starts no process |
| `:connect-on-start` | `true` | Use `false` to open a session without launching LCU, review trust, then explicitly `/computer connect` |
| `:lcu-home` | `LCU_HOME`, otherwise platform installation path | Installed release; macOS `~/.local/share/lcu/current`, Linux `/opt/lcu/current` |
| `:node-command` | `node-path`, otherwise `node` on PATH | Node executable used for the bridge |
| `:lcu-args` | `[]` | Native `computer` surface only; `["--chrome"]` explicitly selects `browser,computer`. No audio or setup commands |
| `:request-timeout-ms` | `60000` | Tool deadline; the example uses `150000` |
| `:startup-timeout-ms` | at least `120000` for LCU | Connection/discovery deadline |
| `:max-images` | `4` | Per-result screenshot count |
| `:max-image-bytes` | `8388608` | Total decoded screenshot bytes per result |

The adapter pins `CUA_REPL_ENABLED_SURFACES` to these configured surfaces. An
unrelated shell's inherited browser/audio setting cannot expand desktop access.
Chrome mode still requires the separately installed official extension. The
official runtime [saves origin decisions under its state root](https://github.com/amontlabs/lcu/blob/v0.11.2/docs/verification/origin-decisions-2026-10-06.md),
so qì creates a fresh owner-only temporary runtime state directory per browser
connection. It passes that root only to the owned LCU child, keeps the original
session/turn IDs, and starts the shared client with an empty origin allowlist.
No existing preferences, browser profile, cookies or credentials are copied.
The directory is removed after closing the transport, including startup failure;
cleanup errors remain visible. An abruptly terminated worker can leave an unused
temporary directory, but it is never reused for a later connection. The adapter
does not install extensions or modify the user's global origin settings.

`/computer status` reports connection state, configured provider, surfaces,
project trust, execution-world and image-model prerequisites. `connect` is
idempotent while healthy. `disconnect` closes the bridge and removes its model
tools. Connection changes require an idle session; cancel the turn first.
An uncertain action survives disconnect and cannot be cleared by `connect`:
inspect the desktop before explicitly using `reconnect`. No command replays
input. Separate sessions own separate bridges and identities, but share the
same physical desktop; this is not desktop isolation across users/sessions.
LCU JavaScript tool errors are also uncertain: code can send input and then fail,
including before a later application-consent request is declined. qì preserves
the original error and images, closes the bridge, and stops the turn. Cleanup
failures are visible in status and retain the same explicit-reconnect boundary.

Web Settings → Tools displays this same status and explicit connection controls
through the existing journaled `command.execute` path. Connecting verifies
tool discovery only, not OS permission or successful screenshot/input. The
default configuration remains disabled, and existing Standard/Creator session
presets do not acquire desktop access. Start a new session using an explicitly
configured, reviewed runtime profile (for CLI: `bb qi-agent --config examples/lcu.edn`);
a Web user preset must include the documented services in dependency order.
Neither the panel nor this repository change trusts an actual project or
changes OS accessibility, recording, credentials, extension or site permissions.

Tool deadlines pause while native or origin approval is pending. The frontend may have its
own prompt deadline (the Web/RPC bridge defaults to five minutes). Cancellation
dismisses pending prompts and closes the transport. No input is automatically
replayed after timeout, disconnection or an SDK exception.

`/computer status` reports the provider, connection, tools and image capability.
After checking a failed/uncertain action on the desktop, `/computer reconnect`
creates a fresh client. Old prepared tools cannot cross the reconnection boundary.
The original session ID and agent-run ID are carried on every call. A completed
run sends `Stop`; a failed or cancelled run sends `Interrupt`. A cleanup failure
closes the client and requires reconnect before further input. Unloading the
provider stops admission, interrupts active work and reaps the owned bridge.

Linux offline fixtures cover origin decisions, malformed requests, exact scope
matching, private-state isolation, reconnect, late cancellation and independent
session interactions. These fixtures do not launch the real LCU runtime, Chrome
extension or a model. Real browser behavior and macOS App acceptance remain
pending. Bridge exit alone does not prove all real LCU descendants completed
native cleanup; that must be checked on the Mac alongside the actual task.

## Tests

```sh
bb test                 # Offline tests, including subprocess bridge coverage
bb test-lcu-e2e         # Opt-in real macOS desktop test; no model API required
# Equivalent: npm run test:lcu-e2e
QI_LCU_E2E_MODEL=gpt-5.6-sol bb test-lcu-e2e  # Live ChatGPT model, existing auth cache
```

The desktop test requires macOS, `swiftc`, installed LCU and granted desktop
permissions. It compiles a disposable native AppKit app with a unique bundle ID,
runs the real qì agent loop through LCU, observes fresh AX IDs, clicks and types,
sets a Unicode value, clicks Verify, and checks both a fresh screenshot/AX result
and an independent JSON file written only by the button handler. The default
planner is deterministic; the optional model mode uses the real ChatGPT adapter.
Failures exit nonzero, including missing runtime, missing screenshots, wrong text
or failed turn cleanup. It never silently skips the desktop checks.

Test-only in-memory trust/tool grants and app consent are restricted to the
disposable fixture; they do not modify the user's trust store or persistent app
permissions. The fixture process is stopped at the end. Reports, screenshots and
session transcripts are saved under ignored `.qi-agent/lcu-e2e/run-*/` directories.
Do not commit desktop transcripts containing user data.

On the macOS runtime exercised here, `typeText` delivered ASCII but dropped Chinese
characters. The E2E separately verifies keyboard input and uses the documented
`setValue` API on the editable AX field to verify Unicode. Models must read back
typed text; input delivery alone is not proof of success. This integration does
not claim to fix the upstream keyboard implementation.

Linux integration follows the same library contract but has not been exercised by
this macOS-specific desktop fixture. Browser, audio and other applications require
their own acceptance tests.

## Verification record — 2026-10-11

Verified on Apple Silicon macOS with LCU **0.11.2**, ChatGPT **26.1007.30912** and
CUA **0.0.29/20261005054403-144090e2ddcb**. The release archive passed its published
SHA-256 check. LCU's installer reported this app/runtime pair as not covered by its
own upstream test matrix; the results below are qì's local acceptance evidence.

| Check | Result |
| --- | --- |
| Deterministic planner → qì → actual LCU → native app | Passed: keyboard input, Unicode AX setter, Verify click, fresh state, two screenshots, independent file oracle |
| Real `gpt-5.6-sol` → ChatGPT adapter → qì → actual LCU → native app | Passed in seven model requests; model detected missing Chinese input, corrected it with `setValue`, verified the final UI and captured two screenshots |
| Turn cleanup and disposal | Original `Stop` completed; tools removed and bridge PID no longer alive |
| Offline regression | `bb test`: 263 tests, 1972 assertions; zero failures/errors |
| ACP compatibility | 13 tests passed |

Local evidence directories (ignored by Git): deterministic final run
`.qi-agent/lcu-e2e/run-6840180587059620013/` and real-model run
`.qi-agent/lcu-e2e/run-11609482522014220679/`. Each contains `report.json`,
`result.json`, before/after screenshots and the session transcript.
