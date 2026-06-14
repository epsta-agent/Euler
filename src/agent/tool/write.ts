/**
 * Write tool - write content to a file, junior-friendly.
 *
 * Improvements for weak models:
 * - Validates `path` and `content` (content must be a string; we allow empty
 *   so the model can truncate a file intentionally).
 * - Refuses to clobber a path that already names a directory (avoids a cryptic
 *   EISDIR later).
 * - Reports the resolved absolute path on success so the model can ground its
 *   next step (e.g. an immediate read to verify).
 */

import { writeFile, stat, chmod } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { Tool, ToolResult } from './types.ts';

/**
 * If the content begins with a shebang line (`#!...`), the file should be
 * executable so the model (or a downstream test) can run `./script`. Weak
 * models rarely remember to `chmod +x`, so we set the bit automatically when a
 * shebang is present. This directly unblocks terminal-bench-style tasks.
 */
function looksExecutable(content: string): boolean {
  return content.startsWith('#!');
}

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write content to a file, creating parent directories if needed. Overwrites existing files. ' +
    'Refuses to overwrite a directory path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write (relative to cwd or absolute)' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const path = record.path;

    if (typeof path !== 'string' || path.length === 0) {
      return { content: "Error: 'path' is required and must be a non-empty string.", isError: true };
    }
    if (typeof record.content !== 'string') {
      return {
        content: "Error: 'content' is required and must be a string. To empty a file, pass an empty string.",
        isError: true,
      };
    }

    try {
      const absolutePath = resolve(process.cwd(), path);

      // Guard against overwriting a directory.
      try {
        const existing = await stat(absolutePath);
        if (existing.isDirectory()) {
          return {
            content: `Error: '${absolutePath}' is an existing directory. Refusing to overwrite a directory with a file.`,
            isError: true,
          };
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, record.content, 'utf-8');

      // Auto-chmod +x for scripts with a shebang so the model (and downstream
      // test commands like `./analyze.sh`) can execute them without an extra
      // step. Platform no-op where the executable bit isn't meaningful.
      if (looksExecutable(record.content)) {
        try {
          await chmod(absolutePath, 0o755);
        } catch {
          // Non-fatal: chmod may fail on platforms that don't support it.
        }
      }
      return { content: `Successfully wrote ${path}`, isError: false };
    } catch (error: any) {
      return { content: `Error writing file: ${error?.message ?? error}`, isError: true };
    }
  },
};
