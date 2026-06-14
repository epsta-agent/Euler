/**
 * LSP tool - Language Server Protocol operations
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import type { Tool, ToolResult } from './types';

interface LSPInput {
  operation: 'diagnostics' | 'symbols' | 'references' | 'rename' | 'definition';
  path: string;
  position?: { line: number; character: number };
  newName?: string;
}

function buildArgs(input: LSPInput): string[] {
  const { operation, path, position, newName } = input;
  const args = [operation, resolve(process.cwd(), path)];

  if (position) args.push(`${position.line}:${position.character}`);
  if (newName) args.push(newName);

  return args;
}

export const lspTool: Tool = {
  name: 'lsp',
  description: 'LSP operations - diagnostics, symbols, references, rename',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['diagnostics', 'symbols', 'references', 'rename', 'definition'],
      },
      path: { type: 'string' },
      position: {
        type: 'object',
        properties: { line: { type: 'number' }, character: { type: 'number' } },
      },
      newName: { type: 'string' },
    },
    required: ['operation', 'path'],
  },
  execute: (input): Promise<ToolResult> => {
    const { operation, path, position, newName } = input as unknown as LSPInput;

    const args = buildArgs({ operation, path, position, newName });

    return new Promise((resolve) => {
      const proc = spawn('lsp', args, { shell: true });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve({ content: 'LSP operation timed out', isError: true });
      }, 10000);

      proc.on('close', (code) => {
        clearTimeout(timer);

        if (code === 0 && stdout) {
          resolve({ content: stdout });
        } else {
          resolve({ content: `LSP error: ${stderr || 'Unknown error'}`, isError: true });
        }
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve({
          content: 'LSP tool not available. Install language server clients.',
          isError: true
        });
      });
    });
  },
};
