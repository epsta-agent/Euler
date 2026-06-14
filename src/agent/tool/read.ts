/**
 * Read tool - read file contents, junior-friendly.
 *
 * Improvements for weak models:
 * - Validates `path` (non-empty string) up front.
 * - Distinguishes "file not found" from "is a directory" with actionable errors
 *   that include the resolved absolute path.
 * - Returns line-numbered output (`<n>: <line>`) so the model can reference
 *   exact lines in subsequent edits, and reports the total line count + a
 *   truncation hint when a slice is returned.
 */

import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import type { Tool, ToolResult } from './types.ts';

/** Default line limit when the caller doesn't specify one. */
const DEFAULT_LIMIT = 2000;

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a file from the filesystem. Returns line-numbered text. Use offset/limit to page ' +
    'through large files. Directories are reported as an error (use the find tool for those).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read (relative to cwd or absolute)' },
      offset: { type: 'number', description: 'Starting line number (1-indexed, default 1)' },
      limit: { type: 'number', description: `Maximum number of lines to read (default ${DEFAULT_LIMIT})` },
    },
    required: ['path'],
  },
  execute: async (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const path = record.path;

    if (typeof path !== 'string' || path.length === 0) {
      return {
        content: "Error: 'path' is required and must be a non-empty string.",
        isError: true,
      };
    }

    const offsetRaw = record.offset;
    const limitRaw = record.limit;
    if (offsetRaw !== undefined && (typeof offsetRaw !== 'number' || !Number.isFinite(offsetRaw))) {
      return { content: "Error: 'offset' must be a finite number (1-indexed line).", isError: true };
    }
    if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isFinite(limitRaw) || limitRaw <= 0)) {
      return { content: "Error: 'limit' must be a positive finite number of lines.", isError: true };
    }

    const offset = (offsetRaw as number | undefined) ?? 1;
    const wantLimit = (limitRaw as number | undefined) ?? DEFAULT_LIMIT;

    try {
      const absolutePath = resolve(process.cwd(), path);

      let stats;
      try {
        stats = await stat(absolutePath);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return {
            content: `Error: file not found at '${absolutePath}'. Check the path and cwd ('${process.cwd()}').`,
            isError: true,
          };
        }
        throw err;
      }

      if (stats.isDirectory()) {
        return {
          content: `Error: '${absolutePath}' is a directory. Use the 'find' tool to list files in a directory.`,
          isError: true,
        };
      }

      const content = await readFile(absolutePath, 'utf-8');
      const lines = content.split('\n');
      // If the file ends with a trailing newline, split produces a trailing
      // empty element; drop it so line counts are intuitive.
      const logical = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

      const startLine = Math.max(1, offset);
      const endLine = Math.min(logical, startLine + wantLimit - 1);

      const numbered: string[] = [];
      for (let ln = startLine; ln <= endLine; ln++) {
        numbered.push(`${String(ln).padStart(6, ' ')}: ${lines[ln - 1] ?? ''}`);
      }

      const truncated = endLine < logical;
      const footer = truncated
        ? `\n\n[${endLine - startLine + 1}/${logical} lines shown — ${logical - endLine} more remain; call read again with offset=${endLine + 1}]`
        : `\n\n[${logical} line${logical === 1 ? '' : 's'} total]`;

      return { content: numbered.join('\n') + footer, isError: false };
    } catch (error: any) {
      return { content: `Error reading file: ${error?.message ?? error}`, isError: true };
    }
  },
};
