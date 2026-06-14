# Terminal-Bench harness

An evaluation harness compatible with the real
[terminal-bench](https://github.com/harbor-framework/terminal-bench) task set.
It runs the Euler agent (real tool-use loop + junior-friendly tools) against
genuine terminal-bench tasks and reports the pass rate.

Both task kinds are supported:
- **Dockerized tasks** (the majority of upstream tasks): the harness builds the
  task image, starts a container, runs the agent inside `/app` via
  `docker exec`, copies `tests/` in, and runs the pytest evaluator in the
  container.
- **Hermetic tasks** (no Dockerfile): the agent operates on a local copy.

The harness does **not** hardcode any API key. The caller supplies one.

## Task format (matches upstream terminal-bench)

```
bench/tasks/<id>/
├── task.yaml          # instruction, parser_name, timeouts, metadata
├── Dockerfile         # (Dockerized tasks) builds the /app environment
├── tests/
│   └── test_outputs.py   # pytest evaluator (the PASS criterion)
└── <input files>      # data the agent works on (copied into /app)
```
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

## Measured result (real upstream terminal-bench tasks)

`deepseek-v4-flash` run against 9 genuine tasks vendored from
`harbor-framework/terminal-bench/original-tasks/`, each built and evaluated in
Docker via the authoritative `run-tests.sh` path:

| difficulty | resolved | total |
|---|---|---|
| easy | 5 | 6 |
| medium | 0 | 3 |
| **all** | **5** | **9 (55.6%)** |

Resolved: `analyze-access-logs`, `broken-python`, `fix-permissions`,
`hello-world`, `multistep-definite-integral`.

Not resolved: `count-dataset-tokens`, `fibonacci-server`, `grid-pattern-transform`
(flaky across runs — model non-determinism), `sqlite-with-gcov`. The failures
are genuine model-capability issues (wrong outputs, server not started), not
harness artifacts — the evaluator runs in each case.

Full per-task output: `bench/results-deepseek-v4-flash-9tasks.json`.

This is a small sample (9 of 241 upstream tasks). To get a leaderboard-scale
number, vendor more tasks into `bench/tasks/` and re-run.
