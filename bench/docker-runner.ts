/**
 * Docker runner for terminal-bench tasks.
 *
 * Real terminal-bench tasks ship a `Dockerfile` that builds an environment
 * rooted at `/app`, and the agent must operate *inside* that container. This
 * runner:
 *   1. builds the task image (`docker build`),
 *   2. starts a long-lived container (`docker run ... sleep infinity`),
 *   3. exposes a tool surface that execs into the container so the agent's
 *      read/write/edit/bash operate on `/app` inside the container,
 *   4. runs the pytest evaluator inside the container via `docker exec`,
 *   5. tears the container down.
 *
 * This is what makes the agent runnable against the actual terminal-bench task
 * set (236/241 tasks are Dockerized), not just hermetic stand-ins.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn as spawnAsync } from 'child_process';

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
  private stopped = false;

  constructor(imageName: string, containerId: string) {
    this.imageName = imageName;
    this.containerId = containerId;
  }

  /** Exec a command in the container at /app. Returns stdout+exit code. */
  async exec(command: string, timeoutMs = 120_000): Promise<{ stdout: string; code: number }> {
    // `docker exec` runs the command; we capture combined stdout+stderr.
    const escaped = command.replace(/'/g, `'\\''`);
    const full = `docker exec ${this.containerId} sh -c 'cd /app && ${escaped}'`;
    return runLocal(full, { timeoutMs });
  }

  /** Write a file inside the container at /app/<path>. */
  async writeFile(containerPath: string, content: string): Promise<void> {
    // Pipe content via stdin to avoid shell-escaping the body.
    return new Promise((resolve, reject) => {
      const p = containerPath.startsWith('/') ? containerPath : `/app/${containerPath}`;
      const proc = spawnAsync('docker', ['exec', '-i', this.containerId, 'sh', '-c', `cat > '${p}'`]);
      proc.stdin?.write(content);
      proc.stdin?.end();
      let err = '';
      proc.stderr?.on('data', (d) => (err += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`write failed: ${err}`))));
    });
  }

  /** Read a file from the container at /app/<path>. */
  async readFile(containerPath: string): Promise<string> {
    const p = containerPath.startsWith('/') ? containerPath : `/app/${containerPath}`;
    const r = await this.exec(`cat '${p}'`);
    return r.stdout;
  }

  /** Make a file executable inside the container. */
  async chmodExec(containerPath: string): Promise<void> {
    const p = containerPath.startsWith('/') ? containerPath : `/app/${containerPath}`;
    await this.exec(`chmod +x '${p}'`);
  }

  /** Stop and remove the container. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await runLocal(`docker rm -f ${this.containerId} 2>/dev/null`, { timeoutMs: 30_000 });
  }
}

/** Build a task image and start a container. Returns the live container. */
export async function startTaskContainer(taskDir: string, taskId: string): Promise<TaskContainer> {
  const dockerfile = join(taskDir, 'Dockerfile');
  if (!existsSync(dockerfile)) {
    throw new Error(`task ${taskId} has no Dockerfile at ${dockerfile}`);
  }
  const imageName = `tb-${taskId}-${randomUUID().slice(0, 8)}`;
  const containerName = `tb-${taskId}-${randomUUID().slice(0, 8)}`;

  // Build.
  const build = await runLocal(`docker build -t ${imageName} .`, { cwd: taskDir, timeoutMs: 600_000 });
  if (build.code !== 0) {
    throw new Error(`docker build failed for ${taskId}:\n${build.stdout.slice(-2000)}`);
  }

  // Run, sleeping forever so we can exec into it. Run unprivileged-ish; mount
  // no host volumes (the task is self-contained in the image).
  const run = await runLocal(
    `docker run -d --name ${containerName} -w /app ${imageName} sh -c 'sleep infinity'`,
    { timeoutMs: 60_000 },
  );
  if (run.code !== 0) {
    await runLocal(`docker rmi ${imageName} 2>/dev/null`);
    throw new Error(`docker run failed for ${taskId}:\n${run.stdout}`);
  }
  // The container id is the first token of `docker run -d` output.
  const containerId = run.stdout.trim().split('\n')[0].trim() || containerName;

  return new TaskContainer(imageName, containerId);
}
