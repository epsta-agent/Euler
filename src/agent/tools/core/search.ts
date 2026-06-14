/**
 * Search tool - Fast regex search following oh-my-pi architecture
 * Uses native FastSearch for ripgrep-like performance
 */

import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { stat } from 'fs/promises';
import type { Tool, ToolResult } from '../types';
import { fastSearch, FastFS } from '../../../native/optimizer';

export const searchTool: Tool = {
  name: 'search',
  description: 'Fast regex search over files, globs, and internal URLs. Returns line numbers and context for matches. Optimized for code search with intelligent defaults.',
  category: 'core',
  parameters: [
    {
      name: 'pattern',
      type: 'string',
      description: 'Search pattern - can be regex or plain text',
      required: true
    },
    {
      name: 'path',
      type: 'string',
      description: 'Path to search (default: current directory)',
      required: false,
      default: '.'
    },
    {
      name: 'file_pattern',
      type: 'string',
      description: 'File glob pattern to filter files (default: all files)',
      required: false,
      default: '*'
    },
    {
      name: 'ignore_case',
      type: 'boolean',
      description: 'Case-insensitive search (default: true)',
      required: false,
      default: true
    },
    {
      name: 'max_results',
      type: 'number',
      description: 'Maximum number of results to return (default: 100)',
      required: false,
      default: 100
    },
    {
      name: 'context_lines',
      type: 'number',
      description: 'Number of context lines around matches (default: 2)',
      required: false,
      default: 2
    },
    {
      name: 'exclude_dirs',
      type: 'array',
      description: 'Directories to exclude (default: node_modules, .git, dist, build)',
      required: false,
      default: ['node_modules', '.git', 'dist', 'build', 'target', 'bin', 'obj']
    }
  ],
  examples: [
    {
      input: {
        pattern: 'function hello',
        file_pattern: '*.ts'
      },
      output: {
        matches: [
          {
            file: 'src/index.ts',
            line: 10,
            column: 1,
            context: ['// Function definition', 'function hello() {', '  return "world";']
          }
        ],
        totalMatches: 1
      },
      description: 'Search for function definition in TypeScript files'
    },
    {
      input: {
        pattern: 'TODO|FIXME',
        ignore_case: true
      },
      output: {
        matches: [
          {
            file: 'src/utils.ts',
            line: 25,
            column: 8,
            context: ['  // TODO: implement this', '  return null;']
          }
        ],
        totalMatches: 1
      },
      description: 'Search for TODO comments'
    },
    {
      input: {
        pattern: '\\bconst\\s+\\w+\\s*=',
        file_pattern: '*.ts',
        context_lines: 1
      },
      output: {
        matches: [{ file: 'src/utils.ts', line: 5, column: 1, match: 'const x = 1', context: ['const x = 1', 'const y = 2'] }],
        totalMatches: 15
      },
      description: 'Search for const declarations with regex'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        pattern,
        path = '.',
        file_pattern = '*',
        ignore_case = true,
        max_results = 100,
        context_lines = 2,
        exclude_dirs = ['node_modules', '.git', 'dist', 'build', 'target', 'bin', 'obj']
      } = input;

      // Build regex from pattern
      const regex = buildRegex(pattern, ignore_case);

      // Get files to search
      const files = await getFiles(path, file_pattern, exclude_dirs);

      // Search files
      const results: SearchMatch[] = [];
      let totalMatches = 0;

      for (const file of files) {
        if (totalMatches >= max_results) break;

        const fileMatches = await searchFile(file, regex, context_lines, max_results - totalMatches);
        results.push(...fileMatches);
        totalMatches += fileMatches.length;
      }

      return {
        success: true,
        data: {
          matches: results,
          totalMatches: results.length,
          pattern,
          filesSearched: files.length
        }
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Search failed'
      };
    }
  }
};

interface SearchMatch {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string[];
}

// Build regex from pattern
function buildRegex(pattern: string, ignoreCase: boolean): RegExp {
  try {
    // Try to use pattern as regex
    return new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch {
    // If invalid regex, escape and use as literal
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, ignoreCase ? 'gi' : 'g');
  }
}

// Get files to search using FastFS
const fastFS = new FastFS();

async function getFiles(
  path: string,
  file_pattern: string,
  exclude_dirs: string[]
): Promise<string[]> {
  return await fastFS.list(path, {
    pattern: file_pattern,
    exclude: exclude_dirs,
    type: 'file'
  });
}

// Check if file matches pattern
function matchesFilePattern(filename: string, pattern: string): boolean {
  // Simple glob matching
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') +
    '$'
  );

  return regex.test(filename);
}

// Search file for matches using native FastSearch
async function searchFile(
  filePath: string,
  regex: RegExp,
  contextLines: number,
  maxMatches: number
): Promise<SearchMatch[]> {
  try {
    const content = await readFile(filePath, 'utf-8');

    // Use native FastSearch for ripgrep-like performance
    const rawResults = fastSearch.search(content, regex.source, {
      ignoreCase: regex.flags.includes('i'),
      maxCount: maxMatches,
      contextBefore: contextLines,
      contextAfter: contextLines
    });

    // Convert to SearchMatch format
    return rawResults.map((r: any) => ({
      file: filePath,
      line: r.line,
      column: r.matches[0]?.column || 1,
      match: r.matches[0]?.text || '',
      context: r.context
    }));
  } catch {
    return [];
  }
}
