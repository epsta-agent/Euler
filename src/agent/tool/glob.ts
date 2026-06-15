/**
 * glob tool — find files matching a pattern.
 *
 * Complements `find` (which delegates to the shell `find` and needs a path +
 * expression). `glob` takes a single shell-style pattern (such as a double-
 * star dot-py for all Python files, or `src/` star star test files) and
 * resolves relative to the cwd, returning matching paths sorted and capped.
 * This is what a model naturally types when looking for "all the Python files"
 * or "the test files", and is cheaper/safer than composing a shell command for
 * the same query.
 */

import { readdir, stat } from 'fs/promises';
import { resolve, relative } from 'path';
import type { Tool, ToolResult } from './types.ts';

/** Minimal shell-glob matcher: supports *, **, and ? plus literal segments. */
function globToRegex(pattern: string): RegExp {
  // Build a regex from the glob, segment by segment.
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches across directory boundaries (including none).
        re += '.*';
        i += 2;
        // eat an optional following slash so "**/x" doesn't require a slash
        if (pattern[i] === '/') i++;
      } else {
        // * matches anything except a slash.
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "**/*.py", "src/**/*.test.ts"). ' +
    'Returns matching paths relative to the cwd, sorted, capped at 200. Faster ' +
    'and less error-prone than composing a `find` shell command for path queries.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern. * matches within a path segment, ** matches across directories.',
      },
      path: {
        type: 'string',
        description: 'Root directory to search (defaults to the current working directory).',
      },
    },
    required: ['pattern'],
  },
  execute: async (input): Promise<ToolResult> => {
    const pattern = input.pattern as string;
    const root = resolve(process.cwd(), (input.path as string) || process.cwd());
    if (!pattern) {
      return { content: 'Error: pattern is required.', isError: true };
    }

    const re = globToRegex(pattern);
    const MAX = 200;
    const matches: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= MAX) return;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (matches.length >= MAX) break;
        if (name === 'node_modules' || name === '.git') continue; // common noise
        const full = resolve(dir, name);
        let isDir = false;
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
        const rel = relative(root, full);
        // Test both the relative path and (for ** patterns) the name itself.
        if (!isDir && (re.test(rel) || re.test(name))) {
          matches.push(rel);
        }
        if (isDir) await walk(full);
      }
    };

    try {
      await walk(root);
      matches.sort();
      const trailer =
        matches.length >= MAX
          ? `\n\n[…truncated at ${MAX} matches — use a more specific pattern…]`
          : '';
      return {
        isError: false,
        content: matches.length ? matches.join('\n') + trailer : 'No files matched the pattern.',
      };
    } catch (error: any) {
      return { content: `Error: ${error?.message ?? error}`, isError: true };
    }
  },
};
