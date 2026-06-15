/**
 * ls tool — list directory entries.
 *
 * The system prompt instructs the model to discover paths before editing, but
 * previously only the heavier `find` tool was available. `ls` gives a cheap,
 * familiar directory listing with file/dir distinction and (optionally) a
 * recursive walk — exactly what the model reaches for first when orienting in
 * an unfamiliar repo.
 */

import { readdir, stat } from 'fs/promises';
import { resolve, relative } from 'path';
import type { Tool, ToolResult } from './types.ts';

export const lsTool: Tool = {
  name: 'ls',
  description:
    'List the contents of a directory. Returns one entry per line, with a ' +
    'trailing "/" on directories. Faster and simpler than `find` when you just ' +
    'want to see what is in a folder.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list (defaults to the current working directory).',
      },
      recursive: {
        type: 'boolean',
        description: 'If true, walk subdirectories (up to a depth limit). Default false.',
      },
    },
    required: [],
  },
  execute: async (input): Promise<ToolResult> => {
    const dir = (input.path as string) || process.cwd();
    const recursive = Boolean(input.recursive);
    const MAX_ENTRIES = 500;

    try {
      const absolute = resolve(process.cwd(), dir);
      // The root must exist and be a directory; surface ENOENT/ENOTDIR as a
      // real error so the model learns the path is wrong. (Subdirs encountered
      // during a recursive walk are still skipped silently — that's a
      // permission issue, not a path-correctness issue.)
      let rootStat;
      try {
        rootStat = await stat(absolute);
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          return { content: `Error: directory not found at '${dir}'`, isError: true };
        }
        throw error;
      }
      if (!rootStat.isDirectory()) {
        return { content: `Error: '${dir}' is not a directory`, isError: true };
      }

      const entries: string[] = [];
      const walk = async (d: string, depth: number): Promise<void> => {
        if (entries.length >= MAX_ENTRIES) return;
        let names: string[];
        try {
          names = await readdir(d);
        } catch {
          return; // unreadable subdir: skip rather than fail the whole call
        }
        for (const name of names) {
          if (entries.length >= MAX_ENTRIES) break;
          if (name.startsWith('.') && name !== '.') continue; // skip hidden noise
          const full = resolve(d, name);
          let isDir = false;
          try {
            isDir = (await stat(full)).isDirectory();
          } catch {
            /* stat failed — treat as file */
          }
          const rel = relative(absolute, full) || name;
          entries.push(isDir ? `${rel}/` : rel);
          if (recursive && isDir && depth < 4) {
            await walk(full, depth + 1);
          }
        }
      };

      await walk(absolute, 0);
      entries.sort();
      const trailer =
        entries.length >= MAX_ENTRIES
          ? `\n\n[…listing truncated at ${MAX_ENTRIES} entries — narrow with a more specific path or use the find tool with a pattern…]`
          : '';
      return { isError: false, content: entries.length ? entries.join('\n') + trailer : '(empty directory)' };
    } catch (error: any) {
      const msg = error?.code === 'ENOENT'
        ? `Error: directory not found at '${dir}'`
        : `Error listing directory: ${error?.message ?? error}`;
      return { content: msg, isError: true };
    }
  },
};
