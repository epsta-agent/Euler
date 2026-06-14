/**
 * Bash tool - execute shell commands, junior-friendly.
 *
 * Improvements for weak models:
 * - Validates `command` (non-empty string) and `timeout` (positive number).
 * - Reports a parseable footer with exit code, signal, and duration so the
 *   model can distinguish "command ran and failed" from "command not found".
 * - Timeout message includes the command and the elapsed time so the model
 *   knows which command to retry differently.
 * - Clamps timeout to a safe maximum.
 */

import { spawn } from 'child_process';
import type { Tool, ToolResult } from './types.ts';

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command and capture stdout+stderr. The result ends with a footer: ' +
    '[exit=<code> signal=<sig> duration=<ms>]. A non-zero exit sets isError=true.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: `Timeout in ms (max ${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ['command'],
  },
  execute: async (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const command = record.command;

    if (typeof command !== 'string' || command.length === 0) {
      return { content: "Error: 'command' is required and must be a non-empty string.", isError: true };
    }

    let timeout = DEFAULT_TIMEOUT_MS;
    if (record.timeout !== undefined) {
      if (typeof record.timeout !== 'number' || !Number.isFinite(record.timeout) || record.timeout <= 0) {
        return { content: `Error: 'timeout' must be a positive number of milliseconds.`, isError: true };
      }
      timeout = Math.min(record.timeout, MAX_TIMEOUT_MS);
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const startedAt = Date.now();

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(command, [], { shell: true });
      } catch (err: any) {
        return resolve({ content: `Error: failed to spawn shell: ${err?.message ?? err}`, isError: true });
      }

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        const elapsed = Date.now() - startedAt;
        resolve({
          content: `Command timed out after ${timeout}ms (elapsed ${elapsed}ms): ${command}`,
          isError: true,
        });
      }, timeout);

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startedAt;
        const output = stderr ? `${stdout}\n${stderr}` : stdout;
        const footer = `[exit=${code ?? 'null'} signal=${signal ?? 'none'} duration=${elapsed}ms]`;
        resolve({
          content: stderr ? `${output}\n${footer}` : `${output}\n${footer}`,
          isError: code !== 0,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({ content: `Error: ${error.message}`, isError: true });
      });
    });
  },
};
