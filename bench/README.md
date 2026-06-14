# Euler SWE-bench Harness

A minimal, self-contained SWE-bench-style evaluation harness for the Euler
agent. It measures the pass rate of a small model (e.g. **deepseek-flash**) on
coding tasks, using the agent's **junior-friendly tool surface** (read / write
/ edit / bash / grep / find) backed by the Rust-native debugger.

## Layout

```
bench/
├── harness.ts     # task loading, workspace prep, test execution, summary
├── drivers.ts     # provider-agnostic agent driver (OpenAI-compatible tool loop)
├── run.ts         # CLI entrypoint
├── tasks/         # one dir per task: task.json + repo_template/
└── report.json    # written after a run (per-task results + aggregate)
```

## Task format

Each task is a directory `bench/tasks/<id>/` with:

- `task.json`:
  ```json
  {
    "id": "string_reverse",
    "problem_statement": "The reverse() function returns the string unchanged; it should reverse it.",
    "fail_to_pass": ["python3 -m pytest test_strutils.py -q"],
    "pass_to_pass": [],
    "language": "python",
    "max_turns": 8
  }
  ```
- `repo_template/`: a writable copy of the project containing the bug + the
  failing test. The harness copies this into a fresh work dir per run.

`fail_to_pass` commands must FAIL on the buggy template and PASS after the
model's fix. `pass_to_pass` (optional) must keep passing (regression guard).

## Running

```bash
# Set the provider key (deepseek-flash uses the OpenAI-compatible API):
export DEEPSEEK_API_KEY=sk-...

# Run all tasks:
bun bench/run.ts

# Run a single task:
bun bench/run.ts --task=string_reverse

# Tune turns / model:
bun bench/run.ts --max-turns=12 --model=deepseek-chat
```

Supported providers (`--provider=`): `deepseek` (default), `openai`,
`anthropic`, `openrouter`. Each reads its key from the corresponding env var.

## What it measures

For each task, the harness:

1. Copies `repo_template/` to a fresh `bench/work/<id>/repo/`.
2. Runs the agent tool loop: the model calls read/edit/bash/... to fix the bug.
3. Runs every `fail_to_pass` command; a task is **resolved** iff all pass (and
   all `pass_to_pass` keep passing).
4. Prints a summary and writes `bench/report.json`.

## Adding real SWE-bench tasks

Drop a task directory under `bench/tasks/`. For official SWE-bench instances,
materialize the repo at `base_commit`, copy in the test patch, and set
`fail_to_pass` / `pass_to_pass` from the instance's `FAIL_TO_PASS` /
`PASS_TO_PASS` fields.

## Validated

The harness was validated with an oracle driver (applies the known fix →
2/2 resolved) and a negative control (no fix → 0/2 resolved), proving the
verifier discriminates real fixes from no-ops.
