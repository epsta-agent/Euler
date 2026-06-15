/**
 * Docker runner for terminal-bench 2.x tasks (Harbor format).
 *
 * Real terminal-bench 2.x tasks live as `environment/Dockerfile` (builds the
 * /app image) + `tests/test.sh` (the verifier). The verifier contract:
 *   - `/tests/` is mounted with the task's tests/ directory,
 *   - `/logs/verifier/` is mounted writable for the reward output,
 *   - test.sh runs pytest against `/tests/test_outputs.py`,
 *   - test.sh writes `1`/`0` to `/logs/verifier/reward.txt`.
 *
 * This runner:
 *   1. builds the task image from `environment/`,
 *   2. starts a long-lived container with /tests and /logs/verifier bind-mounted,
 *   3. exposes a tool surface that execs into the container so the agent's
 *      read/write/edit/bash operate on /app,
 *   4. runs tests/test.sh and reads /logs/verifier/reward.txt,
 *   5. tears the container down.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

/** Run a command locally, returning stdout+exit code. */
export function runLocal(command: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string,string> } = {}): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stdout += d.toString()));
    const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, code: code ?? 0 }); });
    proc.on('error', () => { clearTimeout(timer); resolve({ stdout: stdout + '\n(spawn error)', code: 1 }); });
  });
}

/** A live container the agent operates in. */
export class TaskContainer {
  readonly containerId: string;
  readonly imageName: string;
  /** Host path bind-mounted at /logs/verifier (for reading the reward file). */
  readonly logsHostDir: string;
  private stopped = false;

  constructor(imageName: string, containerId: string, logsHostDir: string) {
    this.imageName = imageName;
    this.containerId = containerId;
    this.logsHostDir = logsHostDir;
  }

  /** Exec a command in the container at /app. Returns stdout+exit code. */
  async exec(command: string, timeoutMs = 120_000): Promise<{ stdout: string; code: number }> {
    const escaped = command.replace(/'/g, `'\\''`);
    const full = `docker exec ${this.containerId} sh -c 'cd /app && ${escaped}'`;
    return runLocal(full, { timeoutMs });
  }

  /** Write a file inside the container at the given (container-absolute) path. */
  async writeFile(containerPath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['exec', '-i', this.containerId, 'sh', '-c', `cat > '${containerPath}'`]);
      proc.stdin?.write(content);
      proc.stdin?.end();
      let err = '';
      proc.stderr?.on('data', (d) => (err += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`write failed: ${err}`))));
    });
  }

  /** Read a file from the container. */
  async readFile(containerPath: string): Promise<string> {
    const r = await this.exec(`cat '${containerPath}'`);
    return r.stdout;
  }

  /** Make a file executable inside the container. */
  async chmodExec(containerPath: string): Promise<void> {
    await this.exec(`chmod +x '${containerPath}'`);
  }

  /** Read the reward file (1 = pass, 0 = fail) written by tests/test.sh. */
  readReward(): number | null {
    const rewardFile = join(this.logsHostDir, 'reward.txt');
    if (!existsSync(rewardFile)) return null;
    const text = readFileSync(rewardFile, 'utf-8').trim();
    if (text === '1') return 1;
    if (text === '0') return 0;
    return null;
  }

  /** Stop and remove the container. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await runLocal(`docker rm -f ${this.containerId} 2>/dev/null`, { timeoutMs: 30_000 });
  }
}

/**
 * Build a task image and start a container for a 2.x task.
 *
 * Mounts the task's tests/ at /tests and a fresh host tmpdir at /logs/verifier
 * (writable), matching the verifier contract. The agent operates at /app.
 */
export async function startTaskContainer(taskDir: string, taskId: string): Promise<TaskContainer> {
  // Resolve taskDir to an absolute path: Docker bind-mounts reject relative
  // host paths ("includes invalid characters for a local volume name"), and
  // callers (sdk.ts) may pass a relative ./bench/tasks.
  const taskDirAbs = resolve(taskDir);
  const envDir = join(taskDirAbs, 'environment');
  const dockerfile = join(envDir, 'Dockerfile');
  if (!existsSync(dockerfile)) {
    throw new Error(`task ${taskId} has no environment/Dockerfile at ${dockerfile}`);
  }

  const tag = randomUUID().slice(0, 8);
  const imageName = `tb2-${taskId}-${tag}`;
  const containerName = `tb2-${taskId}-${tag}`;

  // Build from environment/.
  const build = await runLocal(`docker build -t ${imageName} .`, { cwd: envDir, timeoutMs: 600_000 });
  if (build.code !== 0) {
    throw new Error(`docker build failed for ${taskId}:\n${build.stdout.slice(-2000)}`);
  }

  // Host dirs to bind-mount. Both MUST be absolute for Docker.
  const testsDir = join(taskDirAbs, 'tests');
  const logsHostDir = mkdtempSync(join(tmpdir(), `tb2-logs-${tag}-`));
  // The verifier writes to /logs/verifier/.
  const verifierLogsHostDir = join(logsHostDir, 'verifier');
  mkdirSync(verifierLogsHostDir, { recursive: true });

  // Mount tests/ at /tests (read-only) and the logs host dir at /logs (writable).
  const mounts = [
    `-v ${testsDir}:/tests:ro`,
    `-v ${logsHostDir}:/logs`,
  ].join(' ');

  const run = await runLocal(
    `docker run -d --name ${containerName} ${mounts} -w /app ${imageName} sh -c 'sleep infinity'`,
    { timeoutMs: 60_000 },
  );
  if (run.code !== 0) {
    await runLocal(`docker rmi ${imageName} 2>/dev/null`);
    throw new Error(`docker run failed for ${taskId}:\n${run.stdout}`);
  }
  const containerId = run.stdout.trim().split('\n')[0].trim() || containerName;

  return new TaskContainer(imageName, containerId, verifierLogsHostDir);
}

