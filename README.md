# Euler Agent

A TypeScript coding agent with a Rust-native debugger and a junior-friendly
tool surface, designed to let small models (e.g. **deepseek-v4-flash**) solve
real engineering tasks.

## What's here

- **`native/`** — Rust workspace of native modules, including the real DAP
  debugger (`native/euler-debug/`) and the ratatui TUI (`native/euler-tui/`).
- **`src/agent/`** — the agent: providers, tools, coordinator, sessions. The
  coordinator runs a real tool-use loop (model → tool calls → results → model)
  over an OpenAI-compatible endpoint, so the tools are actually reachable from
  the TUI.
- **`src/native/debug-bridge.ts`** — spawns and talks to the `euler-debug`
  binary over line-delimited JSON.
- **`bench/`** — a self-contained SWE-bench / terminal-bench-style evaluation
  harness with sample tasks.

## The TUI (`native/euler-tui`)

An industrial-grade ratatui frontend that spawns the TS headless agent
(`src/headless.ts`) as a subprocess and drives it over a line-JSON bridge.
The agent loop, tools, context management, and session persistence all live in
the subprocess; the Rust binary is pure frontend.

```bash
cargo build --manifest-path native/Cargo.toml -p euler-tui --release
native/target/release/euler-tui
```

### Configuration

The TUI auto-detects a provider from your environment: it scans the standard
env vars (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `ZAI_API_KEY`, …) and
uses the first one set, so you usually just:

```bash
export OPENAI_API_KEY=sk-...
native/target/release/euler-tui
```

Override anything explicitly:

```
euler-tui [--provider <id>] [--model <id>] [--api-key <key>] [--base-url <url>] [--resume]
```

If no credentials are found, the TUI shows a readable error in-app (it does
**not** crash) with guidance on how to fix it.

### Keymap

| Key | Action |
| --- | --- |
| `Enter` | send message |
| `Alt+Enter` / `Shift+Enter` / `Ctrl-J` | newline (multi-line input) |
| `Esc` | interrupt the running turn (aborts the in-flight model request) |
| `↑` / `↓` | move across input lines, or walk input history on a single line |
| `Ctrl-U` | clear input · `Ctrl-W` delete word back |
| `Home` / `End` | cursor to start / end of current line |
| `PgUp` / `PgDn` / `Ctrl-↑` / `Ctrl-↓` / `Ctrl-Home` / `Ctrl-End` | scroll chat |
| `Ctrl-C` / `Ctrl-D` | quit |

Slash commands: `/help`, `/clear` (reset agent memory + transcript),
`/model [id]`, `/exit`.

### Features

- **Multi-turn memory** — the coordinator keeps the conversation across turns
  (every coding agent does; previously each message started fresh).
- **Interrupt** — `Esc` aborts the current model request via an `AbortSignal`
  without killing the subprocess, so context is preserved.
- **Markdown rendering** — headings, fenced code blocks, inline `code`, and
  **bold** are styled in the chat view.
- **Tool panel** — live tool calls with a one-line verdict (`✓ bash(...) → exit 0`).
- **Session persistence** — each conversation is saved to
  `~/.euler/sessions.db`; `--resume` replays the most recent one.
- **Robust init** — config errors are surfaced in-app, not as a crash.



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

`deepseek-v4-flash` on an 8-task **Terminal-Bench 2.x** sample (4 easy + 3
medium + 1 hard), built and verified via the upstream `tests/test.sh` + reward
file: **6/8 (75.0%)** — 2/4 easy, 3/3 medium, 1/1 hard. Resolved tasks include
`fix-git`, `nginx-request-logging`, `password-recovery` (hard), `regex-log`,
`sqlite-db-truncate`, `prove-plus-comm`. See `bench/README.md` for the full
breakdown and how to run the complete 89-task set.

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
