/**
 * Terminal-Bench 2.x harness (Harbor task format).
 *
 * Matches the real Terminal-Bench 2.0/2.1 task layout:
 *
 *   tasks/<id>/
 *   ├── task.toml             # metadata, [environment], [verifier], [agent]
 *   ├── instruction.md        # the agent instruction (separated from task.yaml)
 *   ├── environment/
 *   │   ├── Dockerfile        # builds the /app image
 *   │   ├── resources/        # optional build resources
 *   │   └── setup.sh          # optional env setup
 *   ├── tests/
 *   │   ├── test.sh           # the verifier: installs uv, runs pytest, writes reward
 *   │   └── test_outputs.py   # pytest evaluator
 *   └── solution/solve.sh     # oracle (not used during eval)
 *
 * Evaluation contract (from every test.sh): pytest runs against
 * `/tests/test_outputs.py` and the verifier writes `1`/`0` to
 * `/logs/verifier/reward.txt`. A task is resolved iff reward == 1.
 *
 * The harness builds the task image, starts a container with the tests/ and
 * logs/ dirs mounted, runs the agent in /app, then runs the verifier and reads
 * the reward file. This is faithful to upstream Harbor semantics.
 */

import { readdir, readFile, copyFile, mkdir, rm, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

// ---------- Task model ----------

export interface TaskSpec {
  id: string;
  instruction: string;
  difficulty?: string;
  category?: string;
  tags?: string[];
  /** Agent wall-clock timeout (sec). */
  agent_timeout_sec: number;
  /** Verifier wall-clock timeout (sec). */
  verifier_timeout_sec: number;
  /** Build wall-clock timeout (sec). */
  build_timeout_sec: number;
  /** Whether the task's environment allows internet (informational). */
  allow_internet: boolean;
  taskDir: string;
}

/** Parse a terminal-bench 2.x task.toml + instruction.md into a TaskSpec. */
export async function loadTask(taskDir: string, id: string): Promise<TaskSpec> {
  const dir = resolve(taskDir, id);
  const tomlRaw = await readFile(join(dir, 'task.toml'), 'utf-8');
  const toml = parseToml(tomlRaw);

  let instruction = '';
  try {
    instruction = (await readFile(join(dir, 'instruction.md'), 'utf-8')).trim();
  } catch {
    instruction = '';
  }

  return {
    id,
    instruction,
    difficulty: toml.metadata?.difficulty,
    category: toml.metadata?.category,
    tags: toml.metadata?.tags,
    agent_timeout_sec: Number(toml.agent?.timeout_sec ?? 900),
    verifier_timeout_sec: Number(toml.verifier?.timeout_sec ?? 900),
    build_timeout_sec: Number(toml.environment?.build_timeout_sec ?? 600),
    allow_internet: toml.environment?.allow_internet !== false,
    taskDir: dir,
  };
}

/**
 * Minimal TOML parser for the terminal-bench task.toml subset. Handles:
 *   key = "value"            (string)
 *   key = 1.0 / 1            (number)
 *   key = true / false       (bool)
 *   key = ["a", "b"]         (array of strings)
 *   [section] / [a.b]        (tables)
 * Not a general TOML parser — just enough for task.toml.
 */
function parseToml(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  let current: any = root;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const parts = tableMatch[1].split('.');
      let node = root;
      for (const part of parts) {
        node[part] = node[part] ?? {};
        node = node[part];
      }
      current = node;
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val: any = kv[2].trim();

    if (val.startsWith('["') || val.startsWith('[ ')) {
      // array of strings
      val = val
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s: string) => s.length > 0);
    } else if (val.startsWith('"')) {
      val = val.replace(/^"/, '').replace(/"$/, '');
    } else if (val === 'true' || val === 'false') {
      val = val === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      val = Number(val);
    }
    current[key] = val;
  }
  return root;
}

// ---------- Discovery ----------

export async function listTasks(taskDir: string): Promise<string[]> {
  if (!existsSync(taskDir)) return [];
  const entries = await readdir(taskDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // terminal-bench 2.x: presence of task.toml marks a task dir.
    if (existsSync(join(taskDir, e.name, 'task.toml'))) ids.push(e.name);
  }
  return ids.sort();
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

// ---------- Reporting ----------

export interface TaskResult {
  id: string;
  resolved: boolean;
  difficulty?: string;
  category?: string;
  turns?: number;
  duration_ms?: number;
  verifier_output?: string;
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
  console.log('\n========== Terminal-Bench 2.x results ==========');
  for (const r of results) {
    const mark = r.resolved ? '✅' : '❌';
    const meta = [r.difficulty, r.category].filter(Boolean).join('/');
    console.log(`${mark} ${r.id}${meta ? `  [${meta}]` : ''}  (turns: ${r.turns ?? '?'})`);
    if (r.error) console.log(`    error: ${r.error}`);
  }
  console.log('------------------------------------------------');
  console.log(`Resolved: ${resolved}/${total}  (${passRate.toFixed(1)}%)`);
  console.log('================================================\n');
}
