/**
 * Debug Bridge - spawns and talks to the `euler-debug` Rust binary.
 *
 * The Rust binary owns the real DAP adapter (debugpy / lldb-dap / dlv / node)
 * and exposes a tiny line-delimited JSON RPC on stdio. We keep one persistent
 * subprocess and send one request per line, reading one response per line.
 *
 * This is the same shape as oh-my-pi's native debugger: a stable,
 * junior-friendly command surface backed by a real DAP client. There are no
 * mocks here — every call drives an actual debug session.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';

/** Shape of every response line from the binary. */
export interface DebugRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Known adapter kinds the binary can drive. */
export type DebugAdapterKind = 'python' | 'lldb' | 'go' | 'node';

/** All RPC ops accepted by the binary, mirroring its `RpcRequest` enum. */
export type DebugOp =
  | { op: 'start'; target: string; adapter?: DebugAdapterKind }
  | { op: 'launch'; program: string; args?: string[] }
  | { op: 'attach'; pid: number }
  | { op: 'setBreakpoints'; source: string; breakpoints: LineBreakpoint[] }
  | { op: 'configurationDone' }
  | { op: 'threads' }
  | { op: 'stackTrace'; threadId: number }
  | { op: 'scopes'; frameId: number }
  | { op: 'variables'; variablesReference: number }
  | { op: 'evaluate'; expression: string; frameId?: number }
  | { op: 'continue'; threadId: number }
  | { op: 'pause'; threadId: number }
  | { op: 'stepOver'; threadId: number }
  | { op: 'stepIn'; threadId: number }
  | { op: 'stepOut'; threadId: number }
  | { op: 'waitForStop'; timeoutMs?: number }
  | { op: 'disconnect'; terminate?: boolean }
  | { op: 'status' };

/** A breakpoint: line plus an optional condition expression. */
export interface LineBreakpoint {
  line: number;
  condition?: string;
}

/** Strongly-typed result shapes (best-effort; the binary is the source of truth). */
export interface DebugThread {
  id: number;
  name: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  source: string | null;
  line: number;
  column: number;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DebugBreakpoint {
  verified: boolean;
  line: number;
  message?: string;
}

/**
 * A persistent client for the `euler-debug` binary.
 *
 * One instance owns one subprocess; call `request()` for each command and
 * `dispose()` when done (or let the process exit). Concurrent requests are
 * serialized to keep the line protocol strictly ordered.
 */
export class DebugBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Array<{
    resolve: (resp: DebugRpcResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly binaryPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: { binaryPath?: string; timeoutMs?: number } = {}) {
    this.binaryPath = opts.binaryPath ?? defaultBinaryPath();
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Spawn the binary if it isn't already running. */
  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));

    this.child.on('exit', (code, signal) => {
      // Reject any in-flight requests when the binary dies.
      const err: DebugRpcResponse = {
        ok: false,
        error: `euler-debug exited (code=${code} signal=${signal ?? 'none'})`,
      };
      while (this.pending.length) {
        const { resolve, timer } = this.pending.shift()!;
        clearTimeout(timer);
        resolve(err);
      }
      this.child = null;
    });

    this.child.on('error', (err) => {
      // Could not spawn at all (binary missing).
      while (this.pending.length) {
        const { resolve, timer } = this.pending.shift()!;
        clearTimeout(timer);
        resolve({ ok: false, error: `failed to spawn euler-debug: ${err.message}` });
      }
    });
  }

  /** Send an op and await its response. Requests are serialized. */
  async request<T = unknown>(op: DebugOp, timeoutMs?: number): Promise<T> {
    await this.start();
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('euler-debug is not running');
    }

    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop this waiter from the queue on timeout.
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`debug RPC '${op.op}' timed out after ${timeout}ms`));
      }, timeout);

      this.pending.push({
        resolve: (resp: DebugRpcResponse) => {
          if (resp.ok) resolve(resp.result as T);
          else reject(new Error(resp.error ?? `debug RPC '${op.op}' failed`));
        },
        timer,
      });

      this.child!.stdin.write(JSON.stringify(op) + '\n');
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let resp: DebugRpcResponse;
    try {
      resp = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines (defensive — the binary should always emit JSON).
      return;
    }
    const waiter = this.pending.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(resp);
  }

  /** Disconnect and terminate the subprocess. */
  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request({ op: 'disconnect', terminate: true }).catch(() => null);
    } finally {
      this.child?.stdin.end();
      this.child?.kill('SIGTERM');
      this.child = null;
    }
  }
}

/** Resolve the default binary path for the host platform + build profile. */
function defaultBinaryPath(): string {
  const workspaceRoot = findWorkspaceRoot();
  const debugProfile = process.env.EULER_DEBUG_PROFILE ?? 'debug';
  const exe = process.platform === 'win32' ? 'euler-debug.exe' : 'euler-debug';
  return join(workspaceRoot, 'native', 'target', debugProfile, exe);
}

function findWorkspaceRoot(): string {
  // The agent runs from the repo root in dev/dist. Walk up from this file.
  // __dirname is not available under Bun's bundler reliably, so use cwd.
  return process.env.EULER_ROOT ?? process.cwd();
}

/** Shared singleton bridge so the agent reuses one debugger subprocess. */
let shared: DebugBridge | null = null;

export function getDebugBridge(): DebugBridge {
  if (!shared) shared = new DebugBridge();
  return shared;
}

export async function disposeDebugBridge(): Promise<void> {
  if (shared) {
    await shared.dispose();
    shared = null;
  }
}
