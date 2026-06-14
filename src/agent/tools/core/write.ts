/**
 * Write tool - Create or overwrite files following oh-my-pi architecture
 * Supports files, archive entries, and SQLite rows
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import type { Tool, ToolResult } from '../types';

export const writeTool: Tool = {
  name: 'write',
  description: 'Create or overwrite a file, archive entry, or SQLite row. Creates parent directories automatically. Supports various content formats.',
  category: 'core',
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'Path to write to - local file path or internal scheme',
      required: true
    },
    {
      name: 'content',
      type: 'string',
      description: 'Content to write - can be text, JSON, or binary data',
      required: true
    },
    {
      name: 'format',
      type: 'string',
      description: 'Content format - auto, text, json, binary',
      required: false,
      default: 'auto'
    },
    {
      name: 'encoding',
      type: 'string',
      description: 'Text encoding - defaults to utf-8',
      required: false,
      default: 'utf-8'
    },
    {
      name: 'create_dirs',
      type: 'boolean',
      description: 'Create parent directories if they don\'t exist',
      required: false,
      default: true
    },
    {
      name: 'backup',
      type: 'boolean',
      description: 'Create backup of existing file',
      required: false,
      default: false
    }
  ],
  examples: [
    {
      input: {
        path: 'src/utils.ts',
        content: 'export function hello() { return "world"; }'
      },
      output: {
        success: true,
        path: 'src/utils.ts',
        bytesWritten: 42
      },
      description: 'Create a new TypeScript file'
    },
    {
      input: {
        path: 'config.json',
        content: '{"key": "value"}',
        format: 'json'
      },
      output: {
        success: true,
        path: 'config.json',
        format: 'json'
      },
      description: 'Write JSON configuration'
    },
    {
      input: {
        path: 'nested/deep/file.txt',
        content: 'content',
        create_dirs: true
      },
      output: {
        success: true,
        directoriesCreated: ['nested', 'nested/deep']
      },
      description: 'Create file with nested directories'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        path: targetPath,
        content,
        format = 'auto',
        encoding = 'utf-8',
        create_dirs = true,
        backup = false
      } = input;

      // Handle internal schemes
      if (targetPath.includes('://') && !targetPath.startsWith('file://')) {
        return await handleInternalScheme(targetPath, content);
      }

      // Handle local filesystem
      return await handleLocalWrite(targetPath, content, format, encoding, create_dirs, backup);

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to write'
      };
    }
  }
};

// Internal scheme handlers
async function handleInternalScheme(path: string, content: any): Promise<ToolResult> {
  const [scheme, ...parts] = path.split('://');
  const resourcePath = parts.join('://');

  switch (scheme) {
    case 'conflict':
      // TODO: Implement conflict resolution writing
      return {
        success: false,
        error: 'Conflict scheme write not yet implemented'
      };

    case 'sqlite':
      // TODO: Implement SQLite row writing
      return {
        success: false,
        error: 'SQLite scheme write not yet implemented'
      };

    default:
      return {
        success: false,
        error: `Unknown internal scheme: ${scheme}`
      };
  }
}

// Local filesystem handler
async function handleLocalWrite(
  path: string,
  content: any,
  format: string,
  encoding: string,
  createDirs: boolean,
  backup: boolean
): Promise<ToolResult> {
  // Prepare content
  let writeContent: string | Buffer = content;

  if (format === 'json' || format === 'auto') {
    try {
      if (typeof content === 'object' && content !== null) {
        writeContent = JSON.stringify(content, null, 2);
      } else if (typeof content === 'string') {
        // Try to parse as JSON to validate
        JSON.parse(content);
        writeContent = content;
      } else {
        writeContent = String(content);
      }
    } catch {
      // If JSON parsing fails, treat as text
      writeContent = String(content);
    }
  } else if (format === 'binary') {
    writeContent = Buffer.from(content, 'base64');
  } else {
    writeContent = String(content);
  }

  // Create backup if requested and file exists
  if (backup && existsSync(path)) {
    await createBackup(path);
  }

  // Create parent directories if needed
  if (createDirs) {
    await mkdir(dirname(path), { recursive: true });
  }

  // Write file
  await writeFile(path, writeContent, typeof writeContent === 'string' ? { encoding: encoding as BufferEncoding } : {});

  const result: any = {
    success: true,
    path,
    bytesWritten: Buffer.byteLength(String(writeContent)),
    type: 'file'
  };

  if (createDirs) {
    result.directoriesCreated = getCreatedDirectories(path);
  }

  if (backup) {
    result.backupCreated = true;
  }

  return {
    success: true,
    data: result
  };
}

// Create backup of existing file
async function createBackup(filePath: string): Promise<void> {
  const backupPath = `${filePath}.backup`;
  const content = await readFile(filePath, 'utf-8');
  await writeFile(backupPath, content);
}

// Get list of created directories
function getCreatedDirectories(filePath: string): string[] {
  const dirs: string[] = [];
  let currentDir = dirname(filePath);

  while (currentDir !== '.' && currentDir !== '/') {
    if (!existsSync(currentDir)) {
      dirs.unshift(currentDir);
    }
    currentDir = dirname(currentDir);
  }

  return dirs;
}

// Import readFile for backup
import { readFile } from 'fs/promises';
