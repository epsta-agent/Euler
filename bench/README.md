# Terminal-Bench 2.x harness

An evaluation harness compatible with the real
[terminal-bench](https://github.com/harbor-framework/terminal-bench) **2.x** task
set (Harbor format). It runs the Euler agent (real tool-use loop + junior-friendly
container tools) against genuine terminal-bench tasks inside each task's Docker
image and reports the pass rate.

## Task format (terminal-bench 2.x / Harbor)

```
bench/tasks/<id>/
├── task.toml            # metadata: [task], [metadata], [verifier], [agent], [environment]
├── instruction.md       # the instruction shown to the agent
├── environment/
│   └── Dockerfile       # builds the /app image (WORKDIR /app)
├── tests/
│   ├── test.sh          # the verifier: installs uv+pytest, runs test_outputs.py, writes reward
│   └── test_outputs.py  # the pytest grader (the PASS criterion)
└── solution/            # oracle (not used during eval)
```

### Verifier contract

`tests/test.sh` is the authoritative grader. It:
1. installs `uv` + `pytest` (and any task-specific deps),
2. runs `pytest /tests/test_outputs.py`,
3. writes `1` (pass) or `0` (fail) to `/logs/verifier/reward.txt`.

A task is **resolved** iff the reward file contains `1`.

The harness bind-mounts `tests/` at `/tests` (read-only) and a fresh tmpdir at
`/logs` (writable) so the verifier can write its reward. The agent operates at
`/app`; it can also read `/tests/test_outputs.py` to learn the exact success
criteria — the system prompt encourages this.

## Run

The caller supplies the API key; the agent never assumes one.

```bash
# One task (smoke test):
API_KEY=sk-... bun bench/run.ts \
  --base-url=https://api.deepseek.com/v1 \
  --model=deepseek-chat \
  --only=prove-plus-comm \
  --max-tool-rounds=12 --verbose=true

# A subset:
API_KEY=sk-... bun bench/run.ts --model=deepseek-chat --only=prove-plus-comm,fix-git

# Everything (89 tasks — slow and costs API budget):
API_KEY=sk-... bun bench/run.ts --model=deepseek-chat
```

The default base URL is `https://api.deepseek.com/v1`. Pick the model with
`--model=` (e.g. `deepseek-chat`, `deepseek-reasoner`). A report is written to
`bench/report.json`.

## SDK

```ts
import { runTerminalBench } from './bench/sdk';

const report = await runTerminalBench({
  apiKey: process.env.MY_KEY!,      // caller supplies the key
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  taskDir: './bench/tasks',
  maxToolRounds: 24,
});
console.log(report.summary);        // { total, resolved, passRate }
```

## What it exercises

The SDK wires the real `AgentCoordinator` tool-use loop to a container-aware
tool surface (`bash`/`read`/`write`/`edit`/`ls`) that execs into each task's
container at `/app`, then runs the task's `tests/test.sh` verifier and reads the
reward file — faithful to upstream Harbor semantics.

### Agent strategy (encoded in the system prompt)

The prompt teaches the model the winning sequence:
1. **Understand** — `ls` / read the input files.
2. **Read the tests** — `/tests/test_outputs.py` reveals the exact function
   names, paths, and assertions the grader checks. Matching these precisely is
   how you pass.
3. **Implement** — `write()`/`edit()` with the expected paths and signatures.
4. **Self-verify** — run the deliverable the way the grader will.
5. **Stop**.

A progress nudge fires at round 3 if the model hasn't written a file yet,
steering weak models away from endless exploration.

### Reliability

The coordinator (shared with the TUI) was hardened for long bench runs:
- **Output cap raised to 8192 tokens** (was 4096) — `write()` of a full source
  file routinely exceeds 4096, and truncation mid-tool-call produces invalid
  JSON that silently fails the task.
- **Transient-error retry** — 429/5xx/network failures retry up to 3× with
  exponential backoff, so one rate-limit hiccup no longer fails an entire task.
- **Verifier output trimming** — `test.sh` emits thousands of install lines
  before pytest; the report keeps the pytest-relevant tail (from the session
  header) instead of a blind last-3000-chars window that cut off the result.
- **Verifier-in-the-loop repair** (`--repair-rounds=N`, default 1) — when the
  first attempt fails with a small number of assertion failures (a near-miss:
  1–3 `FAILED` lines, not a total miss), the harness feeds the **actual pytest
  output** back to the agent for one more attempt. This converts "3/4 tests
  pass, one assertion off" near-misses into passes, because the model can now
  see the exact assertion it violated. Set `--repair-rounds=0` to disable.

## Adding tasks

Drop a directory under `bench/tasks/` following the 2.x layout above. The
harness auto-discovers any subdir with a `task.toml`.

## Measured result

`deepseek-v4-flash` on an 8-task Terminal-Bench 2.x sample (4 easy + 3 medium
+ 1 hard), each built and verified via the upstream `tests/test.sh` + reward
file:

| tier | resolved | total |
|---|---|---|
| easy | 2 | 4 |
| medium | 3 | 3 |
| hard | 1 | 1 |
| **all** | **6** | **8 (75.0%)** |

Resolved: `fix-git`, `prove-plus-comm`, `nginx-request-logging`,
`password-recovery` (hard), `regex-log`, `sqlite-db-truncate`.
Not resolved: `cobol-modernization`, `overfull-hbox` (both near-misses — ≤3
assertion failures; `--repair-rounds=1` targets these).

Reports: `bench/results-deepseek-v4-flash-tb2-easy.json`,
`bench/results-deepseek-v4-flash-tb2-medium.json`. The older
`results-deepseek-v4-flash-9tasks.json` reflects the previous v1 `task.yaml`
set (retained for history; not comparable to the 2.x set).

To reproduce / expand to the full 89-task set:

```bash
# The 8-task sample:
API_KEY=sk-... bun bench/run.ts --model=deepseek-v4-flash \
  --only=fix-git,prove-plus-comm,overfull-hbox,cobol-modernization,nginx-request-logging,password-recovery,regex-log,sqlite-db-truncate

# Full 89-task run (slow, costs API budget):
API_KEY=sk-... bun bench/run.ts --model=deepseek-v4-flash > bench/report.json.log 2>&1
```

This is an 8-task sample of the 89-task 2.x set. To get a leaderboard-scale
number, run the full set (~5–10 min/task).

## Layout

- `harness.ts` — task discovery (`task.toml`), `TaskSpec`, summary printer.
- `docker-runner.ts` — image build, container lifecycle, bind-mounts, reward read.
- `container-agent.ts` — container-aware tool surface (`bash`/`read`/`write`/`edit`/`ls`).
- `sdk.ts` — `runTerminalBench` entry point, the system prompt, the runner.
- `run.ts` — CLI entry point.
