/**
 * Terminal-Bench-compatible harness.
 *
 * Matches the real terminal-bench task schema (see
 * https://github.com/harbor-framework/terminal-bench):
 *
 *   tasks/<id>/task.yaml   — instruction, parser_name, timeouts, metadata
 *   tasks/<id>/tests/      — pytest evaluator (test_outputs.py)
 *   tasks/<id>/*           — input data files the agent works on
 *
 * Evaluation, like upstream, is: run the agent against the instruction in a
 * fresh copy of the task dir; then run the evaluator (`tests/`) with pytest;
 * a task is resolved iff the evaluator passes.
 *
 * The agent loop is supplied by [`createAgentRunner`], which is wired to the
 * real AgentCoordinator tool-use loop + the junior-friendly tool surface.
 *
 * This module does NOT hardcode any API key. The caller (SDK / CLI / TUI) sets
 * the key via options; see `sdk.ts`.
 */

import { readdir, readFile, copyFile, mkdir, rm, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

// ---------- Task model (matches terminal-bench task.yaml) ----------

export interface TaskSpec {
  /** Canonical id (the directory name). */
  id: string;
  /** The instruction shown to the agent. */
  instruction: string;
  /** Evaluator parser; only "pytest" is supported here. */
  parser_name: 'pytest';
  /** Hard cap on agent wall-clock seconds. */
  max_agent_timeout_sec: number;
  /** Hard cap on test wall-clock seconds. */
  max_test_timeout_sec: number;
  /** Metadata (informational only). */
  difficulty?: string;
  category?: string;
  tags?: string[];
  /** Path to the task directory. */
  taskDir: string;
}

/** Parse a terminal-bench task.yaml. We implement a tiny parser to avoid a
 *  hard dependency on a YAML library for the subset we use. */
export async function loadTask(taskDir: string, id: string): Promise<TaskSpec> {
  const raw = await readFile(join(taskDir, id, 'task.yaml'), 'utf-8');
  const parsed = parseTaskYaml(raw);
  return {
    id,
    instruction: parsed.instruction ?? '',
    parser_name: (parsed.parser_name as 'pytest') ?? 'pytest',
    max_agent_timeout_sec: Number(parsed.max_agent_timeout_sec ?? 900),
    max_test_timeout_sec: Number(parsed.max_test_timeout_sec ?? 180),
    difficulty: parsed.difficulty,
    category: parsed.category,
    tags: parsed.tags,
    taskDir: resolve(taskDir, id),
  };
}

/**
 * Minimal YAML parser for the terminal-bench task subset:
 *   instruction: |-    (block scalar)
 *     multiline...
 *   key: value
 *   tags:
 *     - a
 *     - b
 *
 * Good enough for task.yaml; not a general YAML parser.
 */
function parseTaskYaml(text: string): Record<string, any> {
  const out: Record<string, any> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2];

    if (rest === '|-' || rest === '|') {
      // Block scalar: collect indented lines.
      const buf: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        buf.push(lines[i]);
        i++;
      }
      // Strip the common 2-space indent and trailing blank lines.
      const trimmed = buf.join('\n').replace(/^  /gm, '').replace(/\s+$/, '');
      out[key] = trimmed;
      continue;
    }

    if (rest === '') {
      // Possibly a list (tags) or nested map.
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i].startsWith('  - ')) {
        items.push(lines[i].trim().slice(2).trim().replace(/^["']|["']$/g, ''));
        i++;
      }
      if (items.length) { out[key] = items; continue; }
      out[key] = '';
      continue;
    }

    out[key] = rest.replace(/^["']|["']$/g, '');
    i++;
  }
  return out;
}

// ---------- Discovery ----------

export async function listTasks(taskDir: string): Promise<string[]> {
  if (!existsSync(taskDir)) return [];
  const entries = await readdir(taskDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(join(taskDir, e.name, 'task.yaml'))) ids.push(e.name);
  }
  return ids.sort();
}

// ---------- Workspace prep ----------

/** Copy a task's files (minus tests/) into a fresh working directory for the
 *  agent to operate on. The tests/ dir is kept aside for evaluation. */
export async function prepareWorkspace(
  taskDir: string,
  id: string,
  workRoot: string,
): Promise<{ workDir: string; testsDir: string }> {
  const src = resolve(taskDir, id);
  const workDir = resolve(workRoot, id);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'tests' || e.name === 'Dockerfile' || e.name === 'docker-compose.yaml' || e.name === 'run-tests.sh') continue;
    const from = join(src, e.name);
    const to = join(workDir, e.name);
    if (e.isDirectory()) {
      await mkdir(to, { recursive: true });
      // shallow recursive copy
      const { cp } = await import('fs/promises');
      await cp(from, to, { recursive: true });
    } else {
      await copyFile(from, to);
    }
  }

  // Absolute path so pytest can find the tests regardless of the agent's cwd.
  const testsDir = join(src, 'tests');
  return { workDir, testsDir };
}

// ---------- Command runner ----------

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ stdout: string; code: number; timedOut: boolean }> {
  return new Promise((res) => {
    const proc = spawn(command, [], { cwd, shell: true, env: { ...process.env, ...env } });
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

// ---------- Evaluation ----------

/**
 * Run the pytest evaluator for a task in the agent's working directory.
 * Mirrors terminal-bench: `python3 -m pytest <testsDir>/test_outputs.py -rA`,
 * with the working dir set so the tests can read the agent's outputs.
 *
 * Pass: all tests pass (pytest exit 0).
 */
export async function evaluateTask(
  spec: TaskSpec,
  workDir: string,
  testsDir: string,
): Promise<{ resolved: boolean; output: string }> {
  const testFile = join(testsDir, 'test_outputs.py');
  if (!existsSync(testFile)) {
    return { resolved: false, output: `no evaluator at ${testFile}` };
  }
  const result = await runCommand(
    `python3 -m pytest "${testFile}" -rA`,
    workDir,
    spec.max_test_timeout_sec * 1000,
  );
  return { resolved: result.code === 0, output: result.stdout };
}

// ---------- Reporting ----------

export interface TaskResult {
  id: string;
  resolved: boolean;
  difficulty?: string;
  category?: string;
  turns?: number;
  duration_ms?: number;
  evaluator_output?: string;
  error?: string;
}

export function summarize(results: TaskResult[]): {
  total: number;
  resolved: number;
  passRate: number;
} {
  const total = results.length;
  const resolved = results.filter((r) => r.resolved).length;
  return { total, resolved, passRate: total === 0 ? 0 : (resolved / total) * 100 };
}

export function printSummary(results: TaskResult[]): void {
  const { total, resolved, passRate } = summarize(results);
  console.log('\n========== Terminal-Bench results ==========');
  for (const r of results) {
    const mark = r.resolved ? '✅' : '❌';
    const meta = [r.difficulty, r.category].filter(Boolean).join('/');
    console.log(`${mark} ${r.id}${meta ? `  [${meta}]` : ''}  (turns: ${r.turns ?? '?'})`);
    if (r.error) console.log(`    error: ${r.error}`);
  }
  console.log('--------------------------------------------');
  console.log(`Resolved: ${resolved}/${total}  (${passRate.toFixed(1)}%)`);
  console.log('============================================\n');
}
