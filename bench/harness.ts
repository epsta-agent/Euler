/**
 * SWE-bench-style evaluation harness for the Euler agent.
 *
 * Goal: measure the agent's pass rate on small, self-contained coding tasks
 * driven by the junior-friendly tool surface (read/write/edit/bash/grep/find/
 * search + the Rust-native debug tool), using a small model such as
 * deepseek-flash via its OpenAI-compatible API.
 *
 * A "task" is a directory under bench/tasks/<id>/ containing:
 *   - repo/          : a writable copy of the project under test
 *   - task.json      : { id, problem_statement, fail_to_pass: string[], base_commit, language }
 *   - The repo/ dir already has the failing test(s) present but the fix NOT applied.
 *
 * The harness:
 *   1. For each task, starts a fresh AgentCoordinator configured with the
 *      requested provider (deepseek-flash by default).
 *   2. Lets the model edit repo/ using the tools for up to `maxTurns` turns.
 *   3. Runs each fail_to_pass test command in repo/ (PASS_TO_PASS semantics:
 *      a previously-failing test that should now pass).
 *   4. Records pass/fail per task and prints a summary + JSON report.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... bun bench/harness.ts [--task=<id>] [--max-turns=12] [--model=deepseek-chat]
 */

import { readdir, readFile, writeFile, access, rm, mkdir, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

// ---------- Types ----------

export interface TaskSpec {
  id: string;
  problem_statement: string;
  /** Commands that should FAIL before the fix and PASS after. Each runs in repo/. */
  fail_to_pass: string[];
  /** Commands that must keep passing (run after the fix). Optional. */
  pass_to_pass?: string[];
  language: 'python' | 'javascript' | 'go' | 'rust' | 'shell';
  /** Hard cap on agent turns for this task. */
  max_turns?: number;
}

export interface TaskResult {
  id: string;
  resolved: boolean;
  fail_to_pass_results: { command: string; passed: boolean; output: string }[];
  pass_to_pass_results: { command: string; passed: boolean; output: string }[];
  turns_used: number;
  error?: string;
}

export interface HarnessConfig {
  taskDir: string;
  maxTurns: number;
  model: string;
  provider: 'deepseek' | 'openai' | 'anthropic' | 'openrouter';
  apiKey?: string;
  baseURL?: string;
  onlyTask?: string;
  workRoot: string;
  verbose: boolean;
}

// ---------- Task loading ----------

/** Enumerate available task ids by scanning the task directory. */
export async function listTasks(taskDir: string): Promise<string[]> {
  if (!existsSync(taskDir)) return [];
  const entries = await readdir(taskDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(join(taskDir, e.name, 'task.json'))) {
      ids.push(e.name);
    }
  }
  return ids.sort();
}

export async function loadTask(taskDir: string, id: string): Promise<TaskSpec> {
  const raw = await readFile(join(taskDir, id, 'task.json'), 'utf-8');
  const spec = JSON.parse(raw) as TaskSpec;
  spec.id = id;
  return spec;
}

/**
 * Prepare a fresh writable copy of the task's `repo_template/` into
 * `<workRoot>/<id>/repo`. If `repo_template` is absent we assume the repo is
 * already materialized at <taskDir>/<id>/repo.
 */
export async function prepareWorkspace(
  taskDir: string,
  id: string,
  workRoot: string
): Promise<string> {
  const workTask = join(workRoot, id);
  const repo = join(workTask, 'repo');
  await rm(workTask, { recursive: true, force: true });
  await mkdir(workTask, { recursive: true });

  const template = join(taskDir, id, 'repo_template');
  const source = existsSync(template) ? template : join(taskDir, id, 'repo');
  if (existsSync(source)) {
    await cp(source, repo, { recursive: true });
  } else {
    await mkdir(repo, { recursive: true });
  }
  return repo;
}

// ---------- Test execution ----------

/** Run a shell command in `cwd`, returning stdout+stderr, exit code, timed. */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; code: number; timedOut: boolean }> {
  return new Promise((res) => {
    const proc = spawn(command, [], { cwd, shell: true });
    let stdout = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stdout += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      res({ stdout, code: 124, timedOut: true });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      res({ stdout, code: code ?? 0, timedOut: false });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      res({ stdout: stdout + '\n(spawn error)', code: 1, timedOut: false });
    });
  });
}

/** Apply a unified-diff patch string in `cwd` using `git apply`. */
export async function applyPatch(
  patch: string,
  cwd: string
): Promise<{ ok: boolean; message: string }> {
  if (!patch.trim()) return { ok: true, message: 'no patch produced' };
  const { writeFile, unlink } = await import('fs/promises');
  const patchFile = join(cwd, '__euler_patch.diff');
  await writeFile(patchFile, patch, 'utf-8');
  const result = await runCommand(`git apply --whitespace=nowarn ${patchFile}`, cwd);
  await unlink(patchFile).catch(() => {});
  return { ok: result.code === 0, message: result.stdout };
}

// ---------- Harness entrypoint ----------

/**
 * Run a single task using a provided agent driver. The driver is injected so
 * the harness stays provider-agnostic; see `createDeepseekDriver` below.
 */
export async function evaluateTask(
  spec: TaskSpec,
  repoDir: string,
  runAgent: (spec: TaskSpec, repoDir: string) => Promise<{ turns: number; error?: string }>,
  config: HarnessConfig
): Promise<TaskResult> {
  const agentOutcome = await runAgent(spec, repoDir);

  const failResults: TaskResult['fail_to_pass_results'] = [];
  for (const cmd of spec.fail_to_pass) {
    const r = await runCommand(cmd, repoDir);
    failResults.push({ command: cmd, passed: r.code === 0, output: r.stdout.slice(-2000) });
  }

  const passResults: TaskResult['pass_to_pass_results'] = [];
  for (const cmd of spec.pass_to_pass ?? []) {
    const r = await runCommand(cmd, repoDir);
    passResults.push({ command: cmd, passed: r.code === 0, output: r.stdout.slice(-2000) });
  }

  const allFailPass = failResults.every((r) => r.passed);
  const allPassPass = passResults.every((r) => r.passed);

  return {
    id: spec.id,
    resolved: allFailPass && allPassPass,
    fail_to_pass_results: failResults,
    pass_to_pass_results: passResults,
    turns_used: agentOutcome.turns,
    error: agentOutcome.error,
  };
}

/** Compute aggregate stats (without printing). */
export function computeStats(results: TaskResult[]): {
  total: number;
  resolved: number;
  passRate: number;
} {
  const total = results.length;
  const resolved = results.filter((r) => r.resolved).length;
  const passRate = total === 0 ? 0 : (resolved / total) * 100;
  return { total, resolved, passRate };
}

/** Print a human-readable summary and return aggregate stats. */
export function summarize(results: TaskResult[]): {
  total: number;
  resolved: number;
  passRate: number;
} {
  const { total, resolved, passRate } = computeStats(results);

  console.log('\n========== SWE-bench results ==========');
  for (const r of results) {
    const mark = r.resolved ? '✅' : '❌';
    console.log(`${mark} ${r.id}  (turns: ${r.turns_used})`);
    for (const t of r.fail_to_pass_results) {
      console.log(`    ${t.passed ? 'PASS' : 'FAIL'}  ${t.command}`);
    }
    if (r.error) console.log(`    error: ${r.error}`);
  }
  console.log('---------------------------------------');
  console.log(`Resolved: ${resolved}/${total}  (${passRate.toFixed(1)}%)`);
  console.log('=======================================\n');
  return { total, resolved, passRate };
}

/** Persist the full results to a JSON report file (no console output). */
export async function writeReport(
  results: TaskResult[],
  outPath: string
): Promise<void> {
  const report = {
    generated_at: new Date().toISOString(),
    summary: computeStats(results),
    results,
  };
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report written to ${outPath}`);
}

// ---------- CLI ----------

export function parseArgs(argv: string[]): Partial<HarnessConfig> {
  const cfg: Partial<HarnessConfig> = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'task': cfg.onlyTask = v; break;
      case 'max-turns': cfg.maxTurns = Number(v); break;
      case 'model': cfg.model = v; break;
      case 'provider': cfg.provider = v as HarnessConfig['provider']; break;
      case 'task-dir': cfg.taskDir = v; break;
      case 'work-root': cfg.workRoot = v; break;
      case 'verbose': cfg.verbose = v !== 'false' && v !== '0'; break;
    }
  }
  return cfg;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  taskDir: resolve(process.cwd(), 'bench', 'tasks'),
  maxTurns: 12,
  model: 'deepseek-chat',
  provider: 'deepseek',
  workRoot: resolve(process.cwd(), 'bench', 'work'),
  verbose: false,
};

// Re-exported so the CLI entry can compose everything.
export { createAgentDriver, type AgentDriver } from './drivers';
