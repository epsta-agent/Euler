# euler-debug

A Rust-native DAP (Debug Adapter Protocol) bridge for the Euler agent. It
exposes a stable, junior-friendly line-delimited JSON RPC on stdio and drives
**real** DAP adapters underneath — there are no mocks.

## Adapters

| Language | Adapter | Detection |
|---|---|---|
| Python | `debugpy` (`python -m debugpy.adapter`) | `.py` |
| C/C++/Rust | `lldb-dap` / `lldb-vscode` / `codelldb` | `.c .cpp .rs .o` / binary |
| Go | `dlv dap` | `.go` |
| JS/TS | `node` | `.js .ts .mjs .cjs` |

Force an adapter with `{"op":"start","target":"…","adapter":"python"}`.

## Protocol

One JSON request per line on stdin, one JSON response per line on stdout. The
agent process (see `src/native/debug-bridge.ts`) keeps one persistent
subprocess and serializes requests so the line ordering stays strict.

```text
{"op":"start","target":"app.py"}
{"ok":true,"result":{"started":true,"adapter":"python","state":"initialized"}}

{"op":"launch","program":"app.py"}
{"ok":true,"result":{"launched":true,"program":"app.py"}}

{"op":"setBreakpoints","source":"app.py","breakpoints":[{"line":11}]}
{"ok":true,"result":{"breakpoints":[{"verified":true,"line":11}]}}

{"op":"configurationDone"}
{"ok":true,"result":{"configurationDone":true}}

{"op":"continue","threadId":1}
{"ok":true,"result":{"running":true,"threadId":1}}

{"op":"waitForStop","timeoutMs":15000}
{"ok":true,"result":{"wait":{"event":"stopped","threadId":1,"reason":"breakpoint","allThreadsStopped":true}}}
```

### Ops

`start`, `launch`, `attach`, `setBreakpoints`, `configurationDone`, `threads`,
`stackTrace`, `scopes`, `variables`, `evaluate`, `continue`, `pause`,
`stepOver`, `stepIn`, `stepOut`, `waitForStop`, `status`, `disconnect`.

Every response is `{ "ok": bool, "result"?: …, "error"?: "…" }`. Failed
requests return an `error` string that names the missing precondition, e.g.
`"no active session; call 'start' first"`.

### `waitForStop`

After `continue` or any `step*` op, the program runs asynchronously and the
adapter emits a `stopped` event when it pauses. `waitForStop` blocks (one
request in, one response out) until that happens, so the agent does **not**
need to sleep-then-poll `threads`:

```text
{"op":"waitForStop","timeoutMs":15000}
```

- On a stop: `{"wait":{"event":"stopped","threadId":1,"reason":"breakpoint",…}}`
- On termination: `{"wait":{"event":"terminated"}}`
- On timeout (default 30s, hard cap 60s): `{"wait":{"event":"timeout"}}`

It sends no DAP request — it only drains adapter events.

## Lifecycle

The canonical debugging flow:

```text
start → launch → setBreakpoints → configurationDone
       → continue → waitForStop
       → stackTrace → scopes → variables / evaluate
       → (continue | stepOver | stepIn | stepOut) → waitForStop → …
       → disconnect
```

`start` initializes the adapter only; `launch` runs the program. This split
mirrors the DAP spec and lets you set breakpoints before the program executes.

## Resource handling

- **Process-tree teardown.** The adapter is spawned in its own process group
  (Unix `setpgid` / Windows `CREATE_NEW_PROCESS_GROUP`). On `disconnect` or
  `Drop`, the entire tree — adapter **and** debuggee, which some adapters
  (debugpy, dlv) run as a grandchild — is killed via `killpg` (Unix) or
  `taskkill /T` (Windows) and reaped. No orphaned processes.
- **Adapter stderr is drained.** A dedicated background thread reads the
  adapter's stderr and forwards it through the `log` facade, so a chatty
  adapter cannot fill the OS pipe buffer (~64KB) and deadlock the session.
- **Pure stdout.** Log output goes to **stderr** only; stdout carries the JSON
  protocol exclusively. `print_stdout` is a hard clippy error to enforce this.

## Logging

The binary is silent by default. Set `EULER_DEBUG_LOG` to surface adapter
diagnostics (forwarded from the adapter's own stderr) and internal tracing:

```bash
EULER_DEBUG_LOG=debug ./euler-debug   # trace | debug | info | warn | error
```

## Build & test

```bash
cargo build --manifest-path native/Cargo.toml -p euler-debug --bin euler-debug --release
cargo test  --manifest-path native/Cargo.toml -p euler-debug
cargo clippy --manifest-path native/Cargo.toml -p euler-debug --all-targets -- -D warnings
```

The release profile (`native/Cargo.toml`) uses `lto`, `codegen-units = 1`, and
`strip = "symbols"` for a small, fast-startup binary. `panic` is left at
`unwind` so the `Drop`-based teardown reliably runs.

The test suite includes an end-to-end test that drives a **real debugpy**
session: start → launch → set a breakpoint → `continue` → `waitForStop` →
read threads, stack trace, scopes, variables → evaluate `x + y` → disconnect.
It is skipped automatically when debugpy is not installed. A separate unit
test verifies `kill_tree` reaps a deliberately-orphaned grandchild process.

## Layout

- `src/protocol.rs` — DAP `Content-Length` framing (`DapTransport`, `read_one`).
- `src/adapter.rs` — language detection, adapter spawn (process-group aware),
  `kill_tree`, and a dependency-free `which()` (honors `PATHEXT` on Windows).
- `src/client.rs` — `DebugClient`: owns the transport, a background reader
  thread, a stderr-drain thread, sequence-number matching, per-adapter launch
  quirks, and `wait_for_stop`.
- `src/rpc.rs` — the line-JSON request/response surface + `RpcSession`.
- `src/main.rs` — the `euler-debug` binary + the `EULER_DEBUG_LOG` logger.
- `tests/e2e.rs` — integration tests against real adapters.
