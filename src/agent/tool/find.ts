/**
 * Find tool - glob-based file search, junior-friendly.
 *
 * Improvements for weak models:
 * - Validates `pattern` (non-empty string).
 * - Reports a non-existent search path with an actionable error instead of an
 *   empty result the model would misread as "no matches in a real tree".
 * - Emits an explicit, parseable summary line so empty results are
 *   unambiguous ("Found 0 files in '<path>'").
 */

import { glob } from 'glob';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import type { Tool, ToolResult } from './types';

interface FindInput {
  pattern: string;
  path?: string;
  type?: 'file' | 'dir' | 'any';
  maxResults?: number;
}

export const findTool: Tool = {
  name: 'find',
  description:
    'Find files/dirs using a glob pattern (e.g. "**/*.py", "src/**/*.ts"). Returns a list, ' +
    'capped at maxResults. The search path must exist.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.py")' },
      path: { type: 'string', description: 'Directory to search in (default cwd)' },
      type: { type: 'string', enum: ['file', 'dir', 'any'], description: 'Restrict to files, dirs, or either (default any)' },
      maxResults: { type: 'number', description: 'Maximum results (default 100)' },
    },
    required: ['pattern'],
  },
  execute: async (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const pattern = record.pattern;

    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { content: "Error: 'pattern' is required and must be a non-empty glob string.", isError: true };
    }

    const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : '.';
    const type = record.type === 'file' || record.type === 'dir' ? record.type : 'any';
    const maxResults =
      typeof record.maxResults === 'number' && Number.isFinite(record.maxResults) && record.maxResults > 0
        ? record.maxResults
        : 100;

    try {
      const searchPath = resolve(process.cwd(), path);

      try {
        const stats = await stat(searchPath);
        if (!stats.isDirectory()) {
          return {
            content: `Error: '${searchPath}' is not a directory. 'path' must point to a directory.`,
            isError: true,
          };
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return {
            content: `Error: search path '${searchPath}' does not exist. Pass an existing directory in 'path'.`,
            isError: true,
          };
        }
        throw err;
      }

      const results = await glob(pattern, {
        cwd: searchPath,
        maxResults,
        absolute: false,
        nodir: type === 'file',
        onlyDirectories: type === 'dir',
      } as any);

      if (results.length === 0) {
        return { content: `Found 0 files in '${searchPath}' matching '${pattern}'.`, isError: false };
      }

      const listing = results.map((r: string) => `- ${r}`).join('\n');
      return {
        content: `Found ${results.length} file(s) in '${searchPath}' matching '${pattern}':\n${listing}`,
        isError: false,
      };
    } catch (error: any) {
      return { content: `Error: ${error?.message ?? error}`, isError: true };
    }
  },
};
