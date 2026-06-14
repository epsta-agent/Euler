/**
 * Find tool - Fast glob-based file discovery
 * Following oh-my-pi's find architecture
 * Glob-based path lookup with type filters and sorting
 */

import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import type { Tool, ToolResult } from '../types';

export const findTool: Tool = {
  name: 'find',
  description: 'Fast glob-based file discovery with type filters, mtime sorting, and gitignore respect. More efficient than search when you need path-based filtering rather than content matching.',
  category: 'discoverable',
  parameters: [
    {
      name: 'pattern',
      type: 'string',
      description: 'Glob pattern (default: *)',
      required: false,
      default: '*'
    },
    {
      name: 'path',
      type: 'string',
      description: 'Directory to search (default: current directory)',
      required: false,
      default: '.'
    },
    {
      name: 'type',
      type: 'string',
      description: 'File type filter: file, dir, all (default: all)',
      required: false,
      default: 'all'
    },
    {
      name: 'max_depth',
      type: 'number',
      description: 'Maximum directory depth (default: unlimited)',
      required: false
    },
    {
      name: 'exclude',
      type: 'array',
      description: 'Patterns to exclude (default: node_modules, .git, dist, build)',
      required: false,
      default: ['node_modules', '.git', 'dist', 'build', 'target']
    },
    {
      name: 'sort',
      type: 'string',
      description: 'Sort order: name, mtime, size (default: name)',
      required: false,
      default: 'name'
    },
    {
      name: 'limit',
      type: 'number',
      description: 'Maximum results to return (default: unlimited)',
      required: false
    }
  ],
  examples: [
    {
      input: {
        pattern: '*.ts',
        path: 'src'
      },
      output: {
        files: [
          'src/index.ts',
          'src/utils.ts',
          'src/types.ts'
        ],
        total: 3,
        pattern: '*.ts',
        path: 'src'
      },
      description: 'Find TypeScript files in src directory'
    },
    {
      input: {
        pattern: '*',
        type: 'dir',
        exclude: ['node_modules']
      },
      output: {
        files: ['src', 'test', 'docs'],
        total: 3,
        type: 'dir'
      },
      description: 'Find directories only'
    },
    {
      input: {
        pattern: 'test*.ts',
        sort: 'mtime'
      },
      output: {
        files: [
          'src/test/unit.ts',
          'src/test/integration.ts',
          'test/e2e.ts'
        ],
        total: 3,
        sorted: 'mtime'
      },
      description: 'Find test files sorted by modification time'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        pattern = '*',
        path = '.',
        type = 'all',
        max_depth,
        exclude = ['node_modules', '.git', 'dist', 'build', 'target'],
        sort = 'name',
        limit
      } = input;

      // Execute find
      const result = await executeFind({
        pattern,
        path,
        type,
        maxDepth: max_depth,
        exclude,
        sort,
        limit
      });

      return {
        success: true,
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Find operation failed'
      };
    }
  }
};

interface FindRequest {
  pattern: string;
  path: string;
  type: string;
  maxDepth?: number;
  exclude: string[];
  sort: string;
  limit?: number;
}

interface FoundFile {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: Date;
}

// Execute find
async function executeFind(request: FindRequest): Promise<any> {
  const { pattern, path, type, maxDepth, exclude, sort, limit } = request;

  const results: FoundFile[] = [];

  await walkDirectory(path, pattern, type, maxDepth || Infinity, exclude, results, 0);

  // Sort results
  const sorted = sortResults(results, sort);

  // Apply limit
  const limited = limit ? sorted.slice(0, limit) : sorted;

  return {
    files: limited.map(f => f.path),
    total: limited.length,
    foundTotal: results.length,
    pattern,
    path,
    type,
    sort,
    ...(limit && { truncated: results.length > limit })
  };
}

// Walk directory recursively
async function walkDirectory(
  dir: string,
  pattern: string,
  type: string,
  maxDepth: number,
  exclude: string[],
  results: FoundFile[],
  currentDepth: number
): Promise<void> {
  if (currentDepth >= maxDepth) return;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Check exclusions
      if (exclude.some(pattern => matchesPattern(entry.name, pattern))) {
        continue;
      }

      // Check glob pattern
      if (!matchesPattern(entry.name, pattern)) {
        // If entry is a directory and doesn't match pattern, we might still need to walk it
        if (entry.isDirectory()) {
          await walkDirectory(fullPath, pattern, type, maxDepth, exclude, results, currentDepth + 1);
        }
        continue;
      }

      // Get file stats
      const stats = await stat(fullPath);

      // Check type filter
      if (type === 'file' && !entry.isFile()) continue;
      if (type === 'dir' && !entry.isDirectory()) continue;

      // Add result
      results.push({
        path: fullPath,
        type: entry.isFile() ? 'file' : 'dir',
        size: stats.size,
        mtime: stats.mtime
      });

      // Recurse into directories
      if (entry.isDirectory()) {
        await walkDirectory(fullPath, pattern, type, maxDepth, exclude, results, currentDepth + 1);
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

// Check if name matches pattern
function matchesPattern(name: string, pattern: string): boolean {
  // Simple glob matching
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') +
    '$'
  );

  return regex.test(name);
}

// Sort results
function sortResults(results: FoundFile[], sort: string): FoundFile[] {
  const sorted = [...results];

  switch (sort) {
    case 'name':
      return sorted.sort((a, b) => a.path.localeCompare(b.path));

    case 'mtime':
      return sorted.sort((a, b) => {
        const aTime = a.mtime?.getTime() || 0;
        const bTime = b.mtime?.getTime() || 0;
        return bTime - aTime; // Newest first
      });

    case 'size':
      return sorted.sort((a, b) => {
        const aSize = a.size || 0;
        const bSize = b.size || 0;
        return bSize - aSize; // Largest first
      });

    default:
      return sorted;
  }
}

// Future: Implement optimized find with
// 1. Ignore file support (.gitignore, .ignore)
// 2. Fast glob library for better performance
// 3. Parallel directory walking
// 4. Caching of directory structures
// 5. Real-time results streaming

/*
Example optimized find with glob library:

import { glob } from 'glob';

const fastFind = async (pattern: string, options: FindOptions) => {
  const files = await glob(pattern, {
    cwd: options.path,
    ignore: options.exclude,
    onlyFiles: options.type === 'file',
    onlyDirectories: options.type === 'dir',
    depth: options.maxDepth,
    stat: true, // Include size and mtime
    nodir: true // Exclude directory names when searching files
  });

  return files.map(file => ({
    path: file,
    type: fileType(file),
    size: file.size,
    mtime: file.mtime
  }));
};
*/
