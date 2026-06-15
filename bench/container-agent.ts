/**
 * Container-aware agent for Dockerized terminal-bench tasks.
 *
 * The standard agent tools (read/write/edit/bash) operate on the local fs via
 * process.cwd(). For Dockerized tasks the agent must operate *inside* the
 * task container at /app. Rather than wire process.cwd() into Docker, we give
 * the coordinator a dedicated tool set whose handlers shell into the container.
 *
 * These tools mirror the junior-friendly contracts (validation, actionable
 * errors, auto-chmod on shebang) but execute via `docker exec`.
 */

import type { Tool, ToolResult } from '../src/agent/tool/types';
import type { TaskContainer } from './docker-runner';

/** Build a tool surface bound to a live task container. */
export function containerTools(container: TaskContainer): Tool[] {
  const bash: Tool = {
    name: 'bash',
    description:
      'Run a shell command inside the task container at /app. Returns stdout+stderr and an [exit=...] footer.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in /app' },
        timeout: { type: 'number', description: 'Timeout in ms (max 600000)' },
      },
      required: ['command'],
    },
    execute: async (input) => {
      const r = input as Record<string, unknown>;
      const command = r.command;
      if (typeof command !== 'string' || command.length === 0) {
        return { content: "Error: 'command' is required.", isError: true };
      }
      const timeout = typeof r.timeout === 'number' && r.timeout > 0 ? Math.min(r.timeout, 600_000) : 120_000;
      const res = await container.exec(command, timeout);
      return {
        content: `${res.stdout}\n[exit=${res.code}]`,
        isError: res.code !== 0,
      };
    },
  };

  const read: Tool = {
    name: 'read',
    description: 'Read a file inside the task container at /app. Use a path relative to /app.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to /app (or absolute)' },
      },
      required: ['path'],
    },
    execute: async (input) => {
      const r = input as Record<string, unknown>;
      const path = r.path;
      if (typeof path !== 'string' || path.length === 0) {
        return { content: "Error: 'path' is required.", isError: true };
      }
      // cat -n gives line numbers.
      const res = await container.exec(`cat -n '${escapeShell(path)}' 2>&1`);
      if (res.code !== 0) {
        return { content: `Error reading '${path}': ${res.stdout.trim()}`, isError: true };
      }
      return { content: res.stdout, isError: false };
    },
  };

  const write: Tool = {
    name: 'write',
    description:
      'Create or overwrite a file inside the task container at /app. Auto-marks executable if it starts with a shebang.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to /app' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    execute: async (input) => {
      const r = input as Record<string, unknown>;
      const path = r.path;
      const content = r.content;
      if (typeof path !== 'string' || path.length === 0) {
        return { content: "Error: 'path' is required.", isError: true };
      }
      if (typeof content !== 'string') {
        return { content: "Error: 'content' must be a string.", isError: true };
      }
      try {
        await container.writeFile(path, content);
        if (content.startsWith('#!')) {
          await container.chmodExec(path);
        }
        return { content: `Successfully wrote ${path}`, isError: false };
      } catch (err: any) {
        return { content: `Error writing ${path}: ${err?.message ?? err}`, isError: true };
      }
    },
  };

  const edit: Tool = {
    name: 'edit',
    description:
      'Replace an EXACT, unique block of text in a file inside the container. oldText must match exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: async (input) => {
      const r = input as Record<string, unknown>;
      const path = r.path;
      const oldText = r.oldText;
      const newText = r.newText;
      if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
        return { content: "Error: path, oldText, newText are all required strings.", isError: true };
      }
      // Read current content, do the replace in TS (avoids sed quoting hell),
      // write back. Count matches to enforce uniqueness.
      const file = await container.readFile(path);
      const count = countOccurrences(file, oldText);
      if (count === 0) return { content: `Error: oldText not found in ${path}.`, isError: true };
      if (count > 1) return { content: `Error: oldText is ambiguous (${count} matches) in ${path}.`, isError: true };
      const updated = file.replace(oldText, newText);
      await container.writeFile(path, updated);
      return { content: `Successfully edited ${path}`, isError: false };
    },
  };

  const ls: Tool = {
    name: 'ls',
    description: 'List files in a directory inside the container at /app.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to /app (default /app)' },
      },
    },
    execute: async (input) => {
      const r = input as Record<string, unknown>;
      const path = typeof r.path === 'string' && r.path.length > 0 ? r.path : '.';
      const res = await container.exec(`ls -la '${escapeShell(path)}'`);
      return { content: res.stdout, isError: res.code !== 0 };
    },
  };

  return [bash, read, write, edit, ls];
}

function escapeShell(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
