# qì agent Tauri desktop

This package reuses the existing Web UI and authenticated local Host. Its native
Rust shell owns a foreground Rust daemon and a Node Host. The payload includes
the Web build, qi Clojure sources/plugins/presets/assets/protocol, a portable
official Node distribution, Babashka, and the compiled qi executable. A release
app resolves these resources inside its bundle, not from this checkout.

The implementation currently targets **macOS 14+ arm64**. Other platforms are not
built. A successful compilation or an ad-hoc app bundle does **not** establish
that native startup, worker cleanup, project permissions, or computer use E2E
has passed. The full [Harness comparison](../../docs/desktop-harness-comparison.md)
keeps those acceptance items and backend gaps open.

## Build

Use an installed Rust/Xcode command-line toolchain, npm project dependencies,
and the exact installed Babashka binary pinned in `runtime-sources.json`.
`desktop:bootstrap` downloads only the pinned official Node archive and
Babashka license and installs a pinned project-local Tauri CLI from crates.io.
It does not install an application, extension, JVM, or system permission.

```sh
export CARGO_HOME="$PWD/apps/desktop/.cache/cargo"
npm run desktop:bootstrap
npm run desktop:prepare
cargo check --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run test:desktop-unit
npm run test:desktop-rust
```

`QI_DESKTOP_CACHE` can point to the verified download cache; `CARGO_HOME` can
point to a project-private official registry cache. Build dependencies must be
available before the offline preparation/build steps. An absent or mismatched
archive, Babashka binary, or license fails closed. The default profile starts
from the portable Standard preset; computer use remains disabled. An optional
JVM REPL, LSP, Python, Office, pnpm, and an LCU installation are not supplied.

After independent review and a clean local commit:

```sh
npm run desktop:build
npm run desktop:verify
```

The build emits:

- `src-tauri/target/release/bundle/macos/qi-agent.app`
- `../../out/desktop/<version>-aarch64-apple-darwin-<commit>/qi-agent.app`
- the adjacent `qi-agent-<version>-aarch64-apple-darwin-adhoc.dmg` and
  `build-receipt.json`, including the final resource manifest and DMG digest

The DMG uses `hdiutil create` over build-owned content and an Applications link.
It is not mounted or installed by the script. The app is sealed locally with an
ad-hoc identity. No signing key, Apple account, notarization, updater, or release
service is configured or consumed. Packaging subprocesses do not inherit shell
signing credentials. This is a local review candidate, not a signed distribution.
The `licenses` directory carries notices, public source links and a package
inventory. Supplemental texts retain their upstream provenance and checksums;
missing notice files fail the build. Desktop Vite builds disable local `.env`
loading and source maps; normal Web development settings are unchanged.

`npm run desktop:build-app` only compiles/seals/verifies the `.app` and writes an
app-only receipt. It never invokes `hdiutil` or another image packager. This can
produce a revised code candidate while a previous DMG device failure remains
open; it does not convert that failure to a pass or retry the failed operation.

`desktop:dev` explicitly starts a development app and uses `stage/runtime`.
It is a separate runtime action, never part of prepare/check/verify. Do not use
it to bypass an execution or desktop permission denial.

## Ownership and security

The renderer has no Tauri invoke handler, remote capability, shell, or arbitrary
filesystem permission. Project selection, service lifecycle and external links
are native Rust menu actions. A selected path only prefills the existing Web
project confirmation. The Web allowlist, project trust, approvals, command IDs,
and tool policy remain authoritative. Canceling the picker does not change them.

The Host listens only on `127.0.0.1`. A token travels through a private child
pipe to a same-origin bootstrap URL, then the existing Host exchanges it for
its HttpOnly cookie. It is never written to diagnostic logs or native IPC.
The saved private port preserves Web preferences across restarts; a conflicting
port fails rather than attaching to an unknown service. Same-origin file
previews receive no native capabilities. External HTTP(S), mail and telephone
links require a native confirmation and reject embedded credentials, private
bootstrap query keys, native schemes and localhost targets.

App data lives in Tauri's OS app-data directory for
`dev.rainmote.qi-agent.desktop`. The shell and daemon use separate persistent
state leases. Daemon startup validates its actual parent PID. Shutdown uses
the existing idempotent command protocol, waits for a bounded matching response,
then requires a matching cleanup receipt and both owned child exits. Unknown
cleanup retains ownership/runtime evidence and blocks another daemon start.
The shell never kills an unverified PID or deletes an uncertain worker record.
Desktop process admission closes under the existing daemon residency lock;
cleanup drains earlier worker/preset-helper starts before taking its snapshot,
then releases the lock before stopping workers. Residual worker registrations
make the receipt fail rather than silently claiming a complete cleanup.
Permission/interruption errors while checking a PID or group are UNKNOWN; only
`ESRCH` proves absence. A failed fresh worker start keeps private identity
evidence, closes admission, and conservatively keeps the cleanup receipt failed
even after best-effort stopping. It requires reconciliation, not an automatic
retry or a force-restart bypass.

On macOS, closing the main window hides it; the application menu provides an
explicit confirmed exit and service restart. Restart and quit confirmations,
picker results, navigation and service readiness are bound to a generation so
old results cannot act on a later runtime. A crashed service is reported; its
tasks and unknown inputs are not automatically replayed.

## Required real acceptance

Before calling this desktop deliverable complete, validate the **final commit**
and the packaged resources, from outside the source checkout, with an approved
isolated fixture and no real project trust or existing service mutation:

- Offline first start, repeat start, persisted sessions/preferences, second app
  instance, source directory absent, and expected missing-provider states.
- Actual Host → daemon → Babashka worker round trip, not just `/health/ready`.
- Main window hide/reopen; quit/return during startup; repeated restart/quit;
  service failures; child and worker cleanup, including unknown receipt paths.
- Native folder cancel/repeat/stale result, path confirmation, untrusted/trusted
  fixture choice and revoke, refusal, refresh/back and project switching.
- Same-origin file previews/downloads, external link confirmation/refusal,
  blocked schemes, narrow window, and existing Web interaction regressions.
- LCU discovery, actual screenshot/input/cancel/unknown-result cleanup; native
  computer versus separately approved Chrome-origin capability; real-model use.
- Full backend/Host suites with all existing failures individually resolved or
  attributed by valid baseline evidence. A green subset cannot close this gate.

The existing original-isolation `true` probe failed with `sandbox_apply: EPERM`.
Its one authorization was consumed. It does not prove that TCC, an installation,
or a particular nested layer is the cause. Runtime E2E remains blocked until an
explicitly approved usable isolation/execution boundary is available. Neither
this build path nor Tauri changes or removes that boundary.
