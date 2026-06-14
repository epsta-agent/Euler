/**
 * Terminal-Bench SDK.
 *
 * Programmatic entry point for running the agent against terminal-bench tasks.
 * The caller supplies the API key — this module never reads or hardcodes one.
 *
 *   import { runTerminalBench } from './bench/sdk';
 *   const report = await runTerminalBench({
 *     apiKey: process.env.MY_KEY,        // caller decides the source
 *     baseUrl: 'https://api.deepseek.com/v1',
 *     model: 'deepseek-v4-flash',
 *     taskDir: './bench/tasks',
 *     maxToolRounds: 24,
 *   });
 *
 * This wires the real AgentCoordinator tool-use loop to the junior-friendly
 * tool surface (read/write/edit/bash/grep/find/search), so the benchmark
 * exercises the same code path the TUI uses.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { AgentCoordinator } from '../src/agent/agent/coordinator';
import { tools } from '../src/agent/tool/index.ts';
import {
  type TaskSpec,
  type TaskResult,
  listTasks,
  loadTask,
  prepareWorkspace,
  evaluateTask,
  printSummary,
} from './harness';
import { startTaskContainer, TaskContainer, runLocal } from './docker-runner';
import { containerTools } from './container-agent';
import { writeFile, mkdir } from 'fs/promises';

export interface RunOptions {
  /** REQUIRED: the model API key. Supplied by the caller, never hardcoded. */
  apiKey: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Model id, e.g. "deepseek-v4-flash". */
  model: string;
  /** Directory of tasks (each subdir has task.yaml + tests/). */
  taskDir?: string;
  /** Where to materialize per-task work dirs. */
  workRoot?: string;
  /** Max tool-use round trips per task. */
  maxToolRounds?: number;
  /** Only run these task ids. */
  only?: string[];
  /** Print per-turn tool activity. */
  verbose?: boolean;
  /** Extra system-prompt preamble for the agent. */
  systemPromptExtra?: string;
}

export interface RunReport {
  model: string;
  results: TaskResult[];
  summary: { total: number; resolved: number; passRate: number };
}

const BASE_SYSTEM_PROMPT = `You are an autonomous software engineer working in a terminal to complete a SPECIFIC deliverable.

You have these tools:
- read(path, offset?, limit?): read a file (line-numbered).
- write(path, content): create/overwrite a file (auto-marks shebang scripts executable).
- edit(path, oldText, newText): replace an EXACT, unique block of text.
- bash(command, timeout?): run a shell command (use to inspect, build, run tests).
- grep(pattern, path?): search file contents.
- find(pattern, path?): find files by glob.

CRITICAL RULES:
1. Your job is to PRODUCE the deliverable described in the task — a file, a script, an output. Reading and exploring is NOT progress. WRITING the deliverable is progress.
2. Do at most 1-2 reads to understand the inputs, then IMMEDIATELY use write() or edit() to create the required file(s).
3. After writing, VERIFY by running the file (e.g. ./script.sh) or reading it back.
4. The working directory is the current directory; create files there with relative paths.
5. When the deliverable is complete, respond with a one-line summary and STOP calling tools.

Do not loop on exploration. Write the deliverable.`;

/** Create the agent runner bound to the junior-friendly tools. */
function createRunner(opts: RunOptions) {
  return async (spec: TaskSpec, workDir: string): Promise<{ turns: number; error?: string }> => {
    const coordinator = new AgentCoordinator(
      // The tool-use loop uses apiKey + baseUrl directly; the legacy provider
      // is unused for this path, so a stub object is fine.
      {} as any,
      tools,
      {
        provider: 'bench',
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        maxToolRounds: opts.maxToolRounds ?? 24,
        temperature: 0,
        systemPrompt: BASE_SYSTEM_PROMPT + (opts.systemPromptExtra ? '\n\n' + opts.systemPromptExtra : ''),
        // Progress nudge: if the model has done several rounds without writing
        // anything, push it to produce the deliverable. This converts endless
        // exploration into action for weak models.
        onBeforeModelCall: ({ round, toolsCalled }) => {
          const produced = toolsCalled.some((t) => t === 'write' || t === 'edit');
          if (!produced && round >= 3) {
            return (
              'You have called tools several times but have NOT created or modified any file yet. ' +
              'Stop exploring. Call write() NOW to create the deliverable described in the task.'
            );
          }
          return undefined;
        },
      },
    );

    if (opts.verbose) {
      coordinator.onEvent((e) => {
        const d = e.data as any;
        if (e.type === 'tool_start') console.log(`    [tool] ${d.tool}`, JSON.stringify(d.input).slice(0, 120));
      });
    }

    let turns = 0;
    coordinator.onEvent((e) => {
      if (e.type === 'tool_start') turns++;
    });

    try {
      // process.cwd() drives the tools' relative-path resolution; switch into
      // the task work dir for the duration of the run.
      const prev = process.cwd();
      process.chdir(workDir);
      try {
        await coordinator.process(spec.instruction);
      } finally {
        process.chdir(prev);
      }
      return { turns, error: undefined };
    } catch (err: any) {
      return { turns, error: err?.message ?? String(err) };
    }
  };
}

/**
 * Run the agent against every (or `only`) task in `taskDir` and return a
 * report. The caller supplies the API key.
 *
 * Dockerized tasks (those with a Dockerfile) are built and run inside a
 * container; the agent operates on /app via `docker exec`. Hermetic tasks (no
 * Dockerfile) run locally as before.
 */
export async function runTerminalBench(opts: RunOptions): Promise<RunReport> {
  if (!opts.apiKey) throw new Error('runTerminalBench: apiKey is required (caller must supply it)');
  if (!opts.baseUrl) throw new Error('runTerminalBench: baseUrl is required');

  const taskDir = opts.taskDir ?? join(process.cwd(), 'bench', 'tasks');
  const workRoot = opts.workRoot ?? join(process.cwd(), 'bench', 'work');

  const ids = await listTasks(taskDir);
  const chosen = opts.only ? ids.filter((id) => opts.only!.includes(id)) : ids;

  const localRunner = createRunner(opts);
  const results: TaskResult[] = [];

  for (const id of chosen) {
    const spec = await loadTask(taskDir, id);
    const taskPath = join(taskDir, id);
    const isDocker = existsSync(join(taskPath, 'Dockerfile'));
    console.log(`▶ ${id}${isDocker ? ' [docker]' : ''}`);

    let resolved = false;
    let evaluatorOutput = '';
    let turns = 0;
    let error: string | undefined;
    const start = Date.now();

    try {
      if (isDocker) {
        ({ resolved, evaluatorOutput, turns, error } = await runDockerTask(opts, spec, taskPath));
      } else {
        const { workDir, testsDir } = await prepareWorkspace(taskDir, id, workRoot);
        const outcome = await localRunner(spec, workDir);
        turns = outcome.turns;
        error = outcome.error;
        const evalResult = await evaluateTask(spec, workDir, testsDir);
        resolved = evalResult.resolved;
        evaluatorOutput = evalResult.output;
      }
    } catch (err: any) {
      error = err?.message ?? String(err);
    }

    results.push({
      id,
      resolved,
      difficulty: spec.difficulty,
      category: spec.category,
      turns,
      duration_ms: Date.now() - start,
      evaluator_output: evaluatorOutput.slice(-3000),
      error,
    });
    console.log(`  → ${resolved ? 'RESOLVED' : 'NOT resolved'}${error ? ` (${error})` : ''}`);
  }

  printSummary(results);
  return { model: opts.model, results, summary: {
    total: results.length,
    resolved: results.filter((r) => r.resolved).length,
    passRate: results.length === 0 ? 0 : (results.filter((r) => r.resolved).length / results.length) * 100,
  }};
}

/** Run a single Dockerized task: build, start container, agent, evaluator, teardown. */
async function runDockerTask(
  opts: RunOptions,
  spec: TaskSpec,
  taskPath: string,
): Promise<{ resolved: boolean; evaluatorOutput: string; turns: number; error?: string }> {
  const container = await startTaskContainer(taskPath, spec.id);
  try {
    // Copy the task's tests/ directory into /app/tests inside the container.
    // (The Dockerfile only copies task data files; upstream mounts tests/ via
    // docker-compose + TEST_DIR. We `docker cp` it in instead.)
    if (existsSync(join(taskPath, 'tests'))) {
      await runLocal(`docker cp ${join(taskPath, 'tests')} ${container.containerId}:/app/tests`, { timeoutMs: 60_000 });
    }

    // Install pytest in the container robustly. The base image ships Python but
    // not always pytest/pip. Try several install paths so a missing pip (e.g.
    // the "broken-python" task) doesn't silently fail the evaluator.
    const installRes = await container.exec(
      'python3 -m ensurepip --upgrade 2>/dev/null; ' +
      'python3 -m pip install --quiet pytest 2>/dev/null; ' +
      'pip3 install --quiet pytest 2>/dev/null; ' +
      'apt-get update -qq 2>/dev/null && apt-get install -qq -y python3-pytest 2>/dev/null; ' +
      'python3 -c "import pytest" 2>/dev/null && echo PYTEST_OK || echo PYTEST_MISSING',
      180_000,
    );
    const pytestAvailable = installRes.stdout.includes('PYTEST_OK');

    const agentTools = containerTools(container);
    const coordinator = new AgentCoordinator(
      {} as any,
      agentTools,
      {
        provider: 'bench',
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        maxToolRounds: opts.maxToolRounds ?? 24,
        temperature: 0,
        systemPrompt: BASE_SYSTEM_PROMPT +
          '\n\nYou are operating INSIDE a Docker container. The working directory is /app. ' +
          'All file paths are relative to /app. Use the tools to inspect /app, then create ' +
          'the deliverable described in the task.',
        onBeforeModelCall: ({ round, toolsCalled }) => {
          const produced = toolsCalled.some((t) => t === 'write' || t === 'edit');
          if (!produced && round >= 3) {
            return 'You have NOT created or modified any file yet. Stop exploring and call write() NOW to produce the deliverable.';
          }
          return undefined;
        },
      },
    );

    if (opts.verbose) {
      coordinator.onEvent((e) => {
        const d = e.data as any;
        if (e.type === 'tool_start') console.log(`    [tool] ${d.tool}`, JSON.stringify(d.input).slice(0, 120));
      });
    }

    let turns = 0;
    coordinator.onEvent((e) => { if (e.type === 'tool_start') turns++; });

    let error: string | undefined;
    try {
      await coordinator.process(spec.instruction);
    } catch (err: any) {
      error = err?.message ?? String(err);
    }

    // Run the evaluator inside the container at /app. Guard against the
    // container having died during the agent run (a "No such container" error
    // here would be a harness artifact, not a model failure).
    const testDir = '/app/tests';
    const aliveCheck = await runLocal(`docker inspect -f '{{.State.Running}}' ${container.containerId} 2>/dev/null`, { timeoutMs: 10_000 });
    if (!aliveCheck.stdout.trim().startsWith('true')) {
      return {
        resolved: false,
        evaluatorOutput: `container ${container.containerId} is not running; cannot evaluate (harness error, not a model failure)`,
        turns,
        error: 'container died before evaluation',
      };
    }

    // Prefer the task's run-tests.sh when present: upstream tasks use it to
    // install pytest + their specific deps (numpy, requests, ...) via uv, then
    // run pytest. This is the authoritative evaluation path. Fall back to a
    // plain pytest invocation when there's no run-tests.sh.
    const hasRunTests = existsSync(join(taskPath, 'run-tests.sh'));
    // Copy run-tests.sh into the container if present (it lives outside /app
    // in the source tree; the Dockerfile doesn't copy it).
    if (hasRunTests) {
      await runLocal(`docker cp ${join(taskPath, 'run-tests.sh')} ${container.containerId}:/app/run-tests.sh`, { timeoutMs: 30_000 });
      await container.exec('chmod +x /app/run-tests.sh');
    }

    let evalRes;
    if (hasRunTests) {
      // run-tests.sh expects $TEST_DIR and runs in /app.
      evalRes = await container.exec(
        `cd /app && TEST_DIR=${testDir} bash /app/run-tests.sh 2>&1`,
        Math.max((spec.max_test_timeout_sec ?? 180) * 1000, 240_000),
      );
    } else if (pytestAvailable) {
      evalRes = await container.exec(
        `python3 -m pytest ${testDir}/test_outputs.py -rA 2>&1`,
        (spec.max_test_timeout_sec ?? 180) * 1000,
      );
    } else {
      return {
        resolved: false,
        evaluatorOutput: 'pytest could not be installed in the container and no run-tests.sh is present (harness limitation)',
        turns,
        error: 'pytest unavailable',
      };
    }
    return {
      resolved: evalRes.code === 0,
      evaluatorOutput: evalRes.stdout,
      turns,
      error,
    };
  } finally {
    await container.stop();
  }
}

/** Persist a RunReport to disk. */
export async function writeReport(report: RunReport, outPath: string): Promise<void> {
  await mkdir(outPath.substring(0, outPath.lastIndexOf('/')) || '.', { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report written to ${outPath}`);
}
