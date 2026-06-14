/**
 * Grep tool - regex search across files, junior-friendly.
 *
 * Improvements for weak models:
 * - Compiles the regex BEFORE walking the tree so a bad pattern fails fast
 *   with a clear "invalid regex" message (not a silent empty result).
 * - Validates inputs up front.
 * - Reports the search path and pattern in the summary so empty results are
 *   unambiguous.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import ignore from 'ignore';
import type { Tool, ToolResult } from './types';

interface Match {
  file: string;
  line: number;
  text: string;
}

function loadGitignore(searchPath: string): ignore.Ignore {
  const ig = ignore();
  try {
    const gitignore = readFileSync(join(searchPath, '.gitignore'), 'utf-8');
    ig.add(gitignore);
  } catch {}
  return ig;
}

function shouldProcessFile(
  relativePath: string,
  ig: ignore.Ignore,
  filePattern?: string
): boolean {
  if (ig.ignores(relativePath)) return false;
  if (filePattern && !relativePath.match(filePattern)) return false;
  return true;
}

function searchInFile(
  fullPath: string,
  relativePath: string,
  regex: RegExp,
  maxResults: number
): Match[] {
  const matches: Match[] = [];

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      if (matches.length >= maxResults) return;

      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({
          file: relativePath,
          line: idx + 1,
          text: line.trim(),
        });
      }
    });
  } catch {}

  return matches;
}

function searchDirectory(
  searchPath: string,
  ig: ignore.Ignore,
  regex: RegExp,
  filePattern: string | undefined,
  maxResults: number
): Match[] {
  const matches: Match[] = [];
  let entries: string[];
  try {
    entries = readdirSync(searchPath);
  } catch {
    return matches;
  }

  for (const entry of entries) {
    if (matches.length >= maxResults) break;

    const fullPath = join(searchPath, entry);
    const relativePath = fullPath.replace(searchPath + '/', '');

    try {
      const stat = statSync(fullPath);

      if (!shouldProcessFile(relativePath, ig, filePattern)) continue;

      if (stat.isDirectory()) {
        matches.push(...searchDirectory(fullPath, ig, regex, filePattern, maxResults));
      } else if (stat.isFile()) {
        matches.push(...searchInFile(fullPath, relativePath, regex, maxResults));
      }
    } catch {}
  }

  return matches;
}

function formatMatches(matches: Match[], searchPath: string, pattern: string): string {
  if (matches.length === 0) {
    return `No matches for /${pattern}/ under '${searchPath}'.`;
  }

  return `Found ${matches.length} match(es) for /${pattern}/ under '${searchPath}':\n` +
    matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search for a regex pattern across files (respects .gitignore). Returns file:line: text matches. ' +
    'An invalid pattern fails fast with a clear error.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern' },
      path: { type: 'string', description: 'Directory to search in (default cwd)' },
      filePattern: { type: 'string', description: 'Restrict to file paths matching this regex' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' },
      maxResults: { type: 'number', description: 'Maximum matches (default 100)' },
    },
    required: ['pattern'],
  },
  execute: async (input): Promise<ToolResult> => {
    const record = input as Record<string, unknown>;
    const pattern = record.pattern;

    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { content: "Error: 'pattern' is required and must be a non-empty regex string.", isError: true };
    }

    const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : '.';
    const filePattern = typeof record.filePattern === 'string' ? record.filePattern : undefined;
    const caseSensitive = record.caseSensitive === true;
    const maxResults =
      typeof record.maxResults === 'number' && Number.isFinite(record.maxResults) && record.maxResults > 0
        ? record.maxResults
        : 100;

    // Compile first so a bad pattern fails fast.
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (err: any) {
      return {
        content: `Error: invalid regex /${pattern}/: ${err?.message ?? err}. Provide a valid JavaScript regular expression.`,
        isError: true,
      };
    }

    try {
      const searchPath = resolve(process.cwd(), path);

      try {
        const stats = statSync(searchPath);
        if (!stats.isDirectory()) {
          return {
            content: `Error: '${searchPath}' is not a directory. 'path' must point to a directory.`,
            isError: true,
          };
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return {
            content: `Error: search path '${searchPath}' does not exist.`,
            isError: true,
          };
        }
        throw err;
      }

      const ig = loadGitignore(searchPath);
      const matches = searchDirectory(searchPath, ig, regex, filePattern, maxResults);
      return { content: formatMatches(matches, searchPath, pattern), isError: false };
    } catch (error: any) {
      return { content: `Error: ${error?.message ?? error}`, isError: true };
    }
  },
};
