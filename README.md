# Euler Agent

A TypeScript coding agent with a Rust-native debugger and a junior-friendly
tool surface, designed to let small models (e.g. **deepseek-v4-flash**) solve
real engineering tasks.

## What's here

- **`native/`** — Rust workspace of native modules, including the real DAP
  debugger (`native/euler-debug/`).
- **`src/agent/`** — the agent: providers, tools, coordinator, sessions. The
  coordinator runs a real tool-use loop (model → tool calls → results → model)
  over an OpenAI-compatible endpoint, so the tools are actually reachable from
  the TUI.
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

`bench/` is a [terminal-bench](https://github.com/harbor-framework/terminal-bench)
-compatible harness. Each task is `bench/tasks/<id>/` with a real
`task.yaml` (instruction, parser_name, timeouts) + a pytest evaluator
(`tests/test_outputs.py`). The agent runs in a fresh copy of the task files;
a task is resolved iff the evaluator passes.

The harness does **not** hardcode any API key — the caller supplies one:

```bash
API_KEY=sk-... bun bench/run.ts --base-url=https://api.deepseek.com/v1 --model=deepseek-v4-flash
```

Or via the SDK (`bench/sdk.ts`): `runTerminalBench({ apiKey, baseUrl, model })`.

### Measured result

`deepseek-v4-flash` against 9 genuine upstream terminal-bench tasks (built and
evaluated in Docker via the authoritative `run-tests.sh`): **5/9 (55.6%)** —
5/6 on easy, 0/3 on medium. See `bench/README.md` for per-task breakdown.

## Configuration

The agent never hardcodes an API key. It reads the user's environment via
`src/agent/model/provider-config.ts`, which maps a provider to the conventional
env var (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …). When
the key is present, the agent runs the full tool-use loop over the provider's
OpenAI-compatible endpoint; when absent, it falls back to the legacy streaming
path and prints a hint.

Set the key for whichever provider you use:

- `DEEPSEEK_API_KEY` — DeepSeek (`deepseek-v4-flash`, `deepseek-v4-pro`)
- `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, … — others
