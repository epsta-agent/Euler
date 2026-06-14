/**
 * Read tool - Enhanced universal reader following oh-my-pi architecture
 * Supports files, dirs, archives, SQLite, PDFs, URLs, and internal schemes
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Tool, ToolResult } from '../types';

export const readTool: Tool = {
  name: 'read',
  description: 'Universal reader for files, dirs, archives, SQLite, PDFs, notebooks, URLs, and internal schemes. Returns summarized snippets instead of full dumps for token efficiency.',
  category: 'core',
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'Path to read - can be file path, directory, URL, or internal scheme (pr://, issue://, etc.)',
      required: true
    },
    {
      name: 'format',
      type: 'string',
      description: 'Output format - auto, text, json, summary',
      required: false,
      default: 'auto'
    },
    {
      name: 'limit',
      type: 'number',
      description: 'Line limit for files (auto-summarizes if exceeded)',
      required: false,
      default: 1000
    },
    {
      name: 'offset',
      type: 'number',
      description: 'Starting line offset for files',
      required: false,
      default: 0
    }
  ],
  examples: [
    {
      input: { path: 'src/index.ts', limit: 50 },
      output: { content: '...', summary: 'First 50 lines of src/index.ts' },
      description: 'Read first 50 lines of a file'
    },
    {
      input: { path: 'src', format: 'summary' },
      output: { files: ['index.ts', 'utils.ts'], summary: 'Directory contains 2 TypeScript files' },
      description: 'Read directory as summary'
    },
    {
      input: { path: 'https://example.com', format: 'text' },
      output: { content: '...', source: 'https://example.com' },
      description: 'Read URL content'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const { path: targetPath, format = 'auto', limit = 1000, offset = 0 } = input;

      // Handle internal schemes (pr://, issue://, etc.)
      if (targetPath.includes('://') && !targetPath.startsWith('http')) {
        return await handleInternalScheme(targetPath);
      }

      // Handle URLs
      if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
        return await handleURL(targetPath, format);
      }

      // Handle local filesystem
      return await handleLocalPath(targetPath, format, limit, offset);

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to read path'
      };
    }
  }
};

// Internal scheme handlers
async function handleInternalScheme(path: string): Promise<ToolResult> {
  const [scheme, ...parts] = path.split('://');
  const resourcePath = parts.join('://');

  switch (scheme) {
    case 'pr':
    case 'pull':
      // TODO: Implement GitHub PR reading
      return {
        success: false,
        error: 'PR scheme not yet implemented'
      };

    case 'issue':
      // TODO: Implement issue reading
      return {
        success: false,
        error: 'Issue scheme not yet implemented'
      };

    case 'conflict':
      // TODO: Implement conflict resolution reading
      return {
        success: false,
        error: 'Conflict scheme not yet implemented'
      };

    default:
      return {
        success: false,
        error: `Unknown internal scheme: ${scheme}`
      };
  }
}

// URL handler
async function handleURL(url: string, format: string): Promise<ToolResult> {
  try {
    // For now, use fetch (can be enhanced with web_fetch later)
    const response = await fetch(url);
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }

    const content = await response.text();

    return {
      success: true,
      data: {
        content: format === 'json' ? JSON.parse(content) : content,
        source: url,
        type: 'url'
      }
    };

  } catch (error: any) {
    return {
      success: false,
      error: `Failed to fetch URL: ${error.message}`
    };
  }
}

// Local filesystem handler
async function handleLocalPath(
  path: string,
  format: string,
  limit: number,
  offset: number
): Promise<ToolResult> {
  const stats = await stat(path);

  if (stats.isDirectory()) {
    return await readDirectory(path);
  }

  if (stats.isFile()) {
    return await readFileContent(path, format, limit, offset);
  }

  return {
    success: false,
    error: 'Path is neither a file nor a directory'
  };
}

// Read directory
async function readDirectory(dirPath: string): Promise<ToolResult> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    const files = entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name);

    const dirs = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    return {
      success: true,
      data: {
        path: dirPath,
        files,
        directories: dirs,
        summary: `Directory contains ${files.length} files and ${dirs.length} subdirectories`,
        type: 'directory'
      }
    };

  } catch (error: any) {
    return {
      success: false,
      error: `Failed to read directory: ${error.message}`
    };
  }
}

// Read file content
async function readFileContent(
  filePath: string,
  format: string,
  limit: number,
  offset: number
): Promise<ToolResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Get line range
    const startLine = offset;
    const endLine = Math.min(lines.length, offset + limit);
    const selectedLines = lines.slice(startLine, endLine);

    const result: any = {
      path: filePath,
      content: selectedLines.join('\n'),
      startLine: startLine + 1,
      endLine: endLine,
      totalLines: lines.length,
      type: 'file'
    };

    // Add summary if truncated
    if (endLine < lines.length) {
      result.truncated = true;
      result.remainingLines = lines.length - endLine;
      result.summary = `Showing lines ${startLine + 1}-${endLine} of ${lines.length} (${lines.length - endLine} more lines)`;
    }

    // Add format-specific processing
    if (format === 'json') {
      try {
        result.json = JSON.parse(content);
      } catch {
        result.error = 'Content is not valid JSON';
      }
    }

    return {
      success: true,
      data: result
    };

  } catch (error: any) {
    return {
      success: false,
      error: `Failed to read file: ${error.message}`
    };
  }
}
