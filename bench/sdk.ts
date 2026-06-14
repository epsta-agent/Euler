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
 */
export async function runTerminalBench(opts: RunOptions): Promise<RunReport> {
  if (!opts.apiKey) throw new Error('runTerminalBench: apiKey is required (caller must supply it)');
  if (!opts.baseUrl) throw new Error('runTerminalBench: baseUrl is required');

  const taskDir = opts.taskDir ?? join(process.cwd(), 'bench', 'tasks');
  const workRoot = opts.workRoot ?? join(process.cwd(), 'bench', 'work');

  const ids = await listTasks(taskDir);
  const chosen = opts.only ? ids.filter((id) => opts.only!.includes(id)) : ids;

  const runner = createRunner(opts);
  const results: TaskResult[] = [];

  for (const id of chosen) {
    const spec = await loadTask(taskDir, id);
    console.log(`▶ ${id}`);
    const { workDir, testsDir } = await prepareWorkspace(taskDir, id, workRoot);

    const start = Date.now();
    const outcome = await runner(spec, workDir);
    const duration_ms = Date.now() - start;

    const evalResult = await evaluateTask(spec, workDir, testsDir);
    results.push({
      id,
      resolved: evalResult.resolved,
      difficulty: spec.difficulty,
      category: spec.category,
      turns: outcome.turns,
      duration_ms,
      evaluator_output: evalResult.output.slice(-3000),
      error: outcome.error,
    });
    console.log(`  → ${evalResult.resolved ? 'RESOLVED' : 'NOT resolved'}${outcome.error ? ` (${outcome.error})` : ''}`);
  }

  printSummary(results);
  return { model: opts.model, results, summary: {
    total: results.length,
    resolved: results.filter((r) => r.resolved).length,
    passRate: results.length === 0 ? 0 : (results.filter((r) => r.resolved).length / results.length) * 100,
  }};
}

/** Persist a RunReport to disk. */
export async function writeReport(report: RunReport, outPath: string): Promise<void> {
  await mkdir(outPath.substring(0, outPath.lastIndexOf('/')) || '.', { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report written to ${outPath}`);
}
