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

One JSON request per line on stdin, one JSON response per line on stdout.

```text
{"op":"start","target":"app.py"}
{"ok":true,"result":{"started":true,"adapter":"python","state":"initialized"}}

{"op":"launch","program":"app.py"}
{"ok":true,"result":{"launched":true,"program":"app.py"}}

{"op":"setBreakpoints","source":"app.py","breakpoints":[{"line":11}]}
{"ok":true,"result":{"breakpoints":[{"verified":true,"line":11}]}}

{"op":"configurationDone"}
{"ok":true,"result":{"configurationDone":true}}

{"op":"threads"}
{"ok":true,"result":{"threads":[{"id":1,"name":"MainThread"}]}}
```

### Ops

`start`, `launch`, `attach`, `setBreakpoints`, `configurationDone`, `threads`,
`stackTrace`, `scopes`, `variables`, `evaluate`, `continue`, `pause`,
`stepOver`, `stepIn`, `stepOut`, `status`, `disconnect`.

Every response is `{ "ok": bool, "result"?: …, "error"?: "…" }`. Failed
requests return an `error` string that names the missing precondition, e.g.
`"no active session; call 'start' first"`.

## Build & test

```bash
cargo build --manifest-path native/Cargo.toml -p euler-debug --bin euler-debug --release
cargo test  --manifest-path native/Cargo.toml -p euler-debug
```

The test suite includes an end-to-end test that drives a **real debugpy**
session: start → launch → set a breakpoint → hit it → read threads, stack
trace, scopes, variables → evaluate `x + y` → disconnect.

## Layout

- `src/protocol.rs` — DAP `Content-Length` framing.
- `src/adapter.rs` — language detection + adapter spawn.
- `src/client.rs` — `DebugClient`: owns the transport, a background reader
  thread, sequence-number matching, and per-adapter launch quirks.
- `src/rpc.rs` — the line-JSON request/response surface + `RpcSession`.
- `src/main.rs` — the `euler-debug` binary.
