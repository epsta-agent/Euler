# Terminal-Bench harness

An evaluation harness compatible with the
[terminal-bench](https://github.com/harbor-framework/terminal-bench) task
schema. It runs the Euler agent (real tool-use loop + junior-friendly tools)
against terminal-bench tasks and reports the pass rate.

The harness does **not** hardcode any API key. The caller supplies one.

## Task format (matches upstream terminal-bench)

```
bench/tasks/<id>/
├── task.yaml          # instruction, parser_name, timeouts, metadata
├── tests/
│   └── test_outputs.py   # pytest evaluator (the PASS criterion)
└── <input files>      # data the agent works on (e.g. access_log)
```

`task.yaml` fields: `instruction` (shown to the agent), `parser_name` (`pytest`),
`max_agent_timeout_sec`, `max_test_timeout_sec`, `difficulty`, `category`, `tags`.

Evaluation, like upstream: the agent operates in a fresh copy of the task files;
then `python3 -m pytest tests/test_outputs.py` decides resolved/not.

## Run

```bash
# The caller picks the env var; the agent never assumes one.
API_KEY=sk-... bun bench/run.ts \
  --base-url=https://api.deepseek.com/v1 \
  --model=deepseek-v4-flash \
  --max-tool-rounds=12
```

## SDK

```ts
import { runTerminalBench } from './bench/sdk';

const report = await runTerminalBench({
  apiKey: process.env.MY_KEY!,      // caller supplies the key
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  taskDir: './bench/tasks',
  maxToolRounds: 12,
});
console.log(report.summary);        // { total, resolved, passRate }
```

## What it exercises

The SDK wires the real `AgentCoordinator` tool-use loop (the same one the TUI
uses) to the junior-friendly tool surface — `read`/`write`/`edit`/`bash`/
`grep`/`find` — so the benchmark measures the actual agent. Tool input/output is
exactly what the TUI produces.

## Adding tasks

Drop a directory under `bench/tasks/` with a `task.yaml` + `tests/test_outputs.py`
+ any input files. See `bench/tasks/count-log-lines/` for a self-contained
example (no Docker).

## Validated

- Oracle runner (applies the known fix) → 1/1 resolved.
- Real model run: `deepseek-v4-flash` resolves `count-log-lines` in 6 turns.
