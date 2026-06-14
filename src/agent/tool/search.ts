/**
 * Search tool - fast content search, junior-friendly.
 *
 * Prefers ripgrep (`rg`) for speed; falls back to a built-in TypeScript
 * recursive search when `rg` is unavailable so the tool always returns results
 * instead of a hard failure. Validates inputs and reports the pattern + path in
 * the summary.
 */

import { spawn } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import type { Tool, ToolResult } from './types';

interface SearchInput {
  pattern: string;
  path?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

function buildArgs(input: SearchInput): string[] {
  const { pattern, path = '.', filePattern, caseSensitive = false, maxResults = 100 } = input;
  const args = [pattern, resolve(process.cwd(), path)];

  if (!caseSensitive) args.push('-i');
  if (filePattern) args.push('-g', filePattern);
  args.push('-C', '2');
  args.push('--max-count', String(maxResults));

  return args;
}

/** Built-in recursive search used when rg is missing. */
function fallbackSearch(
  root: string,
  pattern: string,
  caseSensitive: boolean,
  filePattern: string | undefined,
  maxResults: number
): string {
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return `No matches (invalid regex /${pattern}/).`;
  }

  const out: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string) => {
    if (out.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxResults) return;
      const full = join(dir, entry);
      if (visited.has(full)) continue;
      visited.add(full);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'target') continue;
        walk(full);
      } else if (stat.isFile()) {
        const rel = relative(root, full);
        if (filePattern && !rel.match(filePattern)) continue;
        let content: string;
        try {
          content = readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (out.length >= maxResults) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            out.push(`${rel}:${i + 1}:${lines[i]}`);
          }
        }
      }
    }
  };

  walk(root);
  return out.length === 0 ? `No matches for /${pattern}/ under '${root}'.` : out.join('\n');
}

export const searchTool: Tool = {
  name: 'search',
  description:
    'Search file contents for a pattern (regex). Uses ripgrep when available, else a built-in fallback. ' +
    'Returns file:line: content matches. Always returns a result (never a hard failure).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern to search for (regex)' },
      path: { type: 'string', description: 'Directory to search in (default cwd)' },
      filePattern: { type: 'string', description: 'Restrict to file paths matching this glob/regex' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' },
      maxResults: { type: 'number', description: 'Maximum matches (default 100)' },
    },
    required: ['pattern'],
  },
  execute: (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const pattern = record.pattern;

    if (typeof pattern !== 'string' || pattern.length === 0) {
      return Promise.resolve({
        content: "Error: 'pattern' is required and must be a non-empty string.",
        isError: true,
      });
    }

    const parsed: SearchInput = {
      pattern,
      path: typeof record.path === 'string' && record.path.length > 0 ? record.path : '.',
      filePattern: typeof record.filePattern === 'string' ? record.filePattern : undefined,
      caseSensitive: record.caseSensitive === true,
      maxResults:
        typeof record.maxResults === 'number' && Number.isFinite(record.maxResults) && record.maxResults > 0
          ? record.maxResults
          : 100,
    };

    const args = buildArgs(parsed);
    const searchPath = resolve(process.cwd(), parsed.path ?? '.');

    return new Promise((resolveP) => {
      const proc = spawn('rg', args, { shell: true });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolveP({ content: `Search timed out for /${parsed.pattern}/ under '${searchPath}'.`, isError: true });
      }, 30000);

      proc.on('close', (code) => {
        clearTimeout(timer);

        if (code === 0 || stdout) {
          resolveP({ content: stdout || `No matches for /${parsed.pattern}/ under '${searchPath}'.`, isError: false });
        } else if (stderr.includes('No matches found')) {
          resolveP({ content: `No matches for /${parsed.pattern}/ under '${searchPath}'.`, isError: false });
        } else {
          resolveP({ content: `Search error: ${stderr}`, isError: true });
        }
      });

      proc.on('error', () => {
        clearTimeout(timer);
        // rg not installed — fall back to the built-in recursive search so the
        // tool still produces results instead of a hard failure.
        try {
          const fb = fallbackSearch(
            searchPath,
            parsed.pattern,
            parsed.caseSensitive ?? false,
            parsed.filePattern,
            parsed.maxResults ?? 100
          );
          resolveP({ content: fb, isError: false });
        } catch (err: any) {
          resolveP({ content: `Error: ${err?.message ?? err}`, isError: true });
        }
      });
    });
  },
};
