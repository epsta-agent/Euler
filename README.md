# Euler Agent

A TypeScript coding agent with a Rust-native debugger and a junior-friendly
tool surface, designed to let small models (e.g. **deepseek-v4-flash**) solve
real engineering tasks.

## What's here

- **`native/`** — Rust workspace of native modules, including the real DAP
  debugger (`native/euler-debug/`).
- **`src/agent/`** — the agent: providers, tools, coordinator, sessions.
- **`src/native/debug-bridge.ts`** — spawns and talks to the `euler-debug`
  binary over line-delimited JSON.
- **`bench/`** — a self-contained SWE-bench / terminal-bench-style evaluation
  harness with sample tasks.

## Rust-native debugger (`native/euler-debug`)

A standalone binary + library that drives **real DAP adapters** — no mocks:

- `debugpy` (Python), `lldb-dap` / `codelldb` (C/C++/Rust), `dlv` (Go),
  `node` (JavaScript/TypeScript).
- Real DAP `Content-Length` JSON-RPC framing, with a dedicated background
  reader thread.
- A junior-friendly line-JSON RPC surface on stdio: one op per line, one
  response per line, with errors that name the missing precondition.
- Full lifecycle: `start → launch → setBreakpoints → configurationDone →
  threads → stackTrace → scopes → variables / evaluate`.

```bash
cargo build --manifest-path native/Cargo.toml -p euler-debug --bin euler-debug --release
echo '{"op":"status"}' | native/target/release/euler-debug
```

See `native/euler-debug/README.md` for the protocol.

## Junior-friendly tools

Every tool validates its inputs up front and returns an actionable error that
names exactly what's missing — so a weak model can recover without guessing.

- `read` — line-numbered output, distinguishes missing-file vs directory.
- `write` — auto-sets the executable bit on shebang scripts (unblocks
  terminal-bench-style tasks where `./script.sh` must run).
- `edit` — rejects ambiguous (multi-match) anchors; refuses stale no-op edits.
- `bash` — parseable `[exit=… signal=… duration=…]` footer.
- `grep` / `find` / `search` — validate pattern + path; `search` falls back to
  a built-in walker when `rg` is absent.
- `debug` — discrete DAP ops (`start`, `launch`, `setBreakpoints`, …)
  delegating to the Rust binary.

## Build

```bash
bun install                # TypeScript deps
./build-native.sh          # WASM modules + the euler-debug binary
cargo test --manifest-path native/Cargo.toml --workspace   # 30+ native tests
bun test                   # agent tests
```

## Benchmark

`bench/` is a SWE-bench / terminal-bench-style harness. Each task is a
directory under `bench/tasks/<id>/` with a `task.json` (problem statement +
`fail_to_pass` test commands) and a `repo_template/`.

```bash
DEEPSEEK_API_KEY=sk-... bun bench/run.ts --model=deepseek-v4-flash --max-turns=8
```

### Measured results (this task set)

| Model | Resolved | Pass rate |
|---|---|---|
| `deepseek-v4-flash` | 6/7 | **85.7%** |
| `deepseek-v4-pro` | 7/7 | **100%** |

The flash model lands one task behind the pro model; the gap is a case where
flash reasoned about the answer but didn't persist the file. Full per-task
results: `bench/results-deepseek-v4-flash.json`,
`bench/results-deepseek-v4-pro.json`.

The harness was validated with an oracle driver (applies the known fix → 7/7)
and a negative control (no fix → 0/2), so the verifier discriminates real
fixes from no-ops.

## Configuration

Set the provider key for the model you want to use:

- `DEEPSEEK_API_KEY` — DeepSeek (`deepseek-v4-flash`, `deepseek-v4-pro`)
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` — others
