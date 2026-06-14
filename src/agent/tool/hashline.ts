/**
 * Hashline edit tool - content-hash anchored patches
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { createHash } from 'crypto';
import type { Tool, ToolResult } from './types';

interface HashlineEditInput {
  path: string;
  edits: Array<{
    hash: string;
    oldText: string;
    newText: string;
  }>;
}

interface HashlineMatch {
  hash: string;
  startLine: number;
  endLine: number;
  found: boolean;
  edit: { oldText: string; newText: string };
}

function computeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 16);
}

function findMatches(lines: string[], edits: HashlineEditInput['edits']): HashlineMatch[] {
  const matches: HashlineMatch[] = edits.map(edit => ({
    hash: edit.hash,
    startLine: -1,
    endLine: -1,
    found: false,
    edit: { oldText: edit.oldText, newText: edit.newText }
  }));

  for (let i = 0; i < lines.length; i++) {
    const lineHash = computeHash(lines[i]);
    const windowStart = Math.max(0, i - 2);
    const windowEnd = Math.min(lines.length, i + 3);
    const windowText = lines.slice(windowStart, windowEnd).join('\n');
    const windowHash = computeHash(windowText);

    for (const match of matches) {
      if (!match.found && (match.hash === lineHash || match.hash === windowHash)) {
        match.found = true;
        match.startLine = windowStart;
        match.endLine = windowEnd;
      }
    }
  }

  return matches;
}

function applyEdits(content: string, matches: HashlineMatch[]): string {
  if (matches.length === 0) return content;

  const lines = content.split('\n');
  const sortedMatches = [...matches].sort((a, b) => b.startLine - a.startLine);
  let modified = content;

  for (const match of sortedMatches) {
    const { startLine, endLine, edit } = match;
    const oldLines = lines.slice(startLine, endLine);
    const oldText = oldLines.join('\n');

    if (oldText.includes(edit.oldText)) {
      modified = modified.replace(oldText, edit.newText);
    }
  }

  return modified;
}

export const hashlineEditTool: Tool = {
  name: 'hashline_edit',
  description: 'Edit files using content-hash anchored patches',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hash: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
          required: ['hash', 'oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  execute: async (input): Promise<ToolResult> => {
    const { path, edits } = input as unknown as HashlineEditInput;

    try {
      const absolutePath = resolve(process.cwd(), path);
      const content = await readFile(absolutePath, 'utf-8');
      const lines = content.split('\n');

      const matches = findMatches(lines, edits);
      const notFound = matches.filter(m => !m.found);

      if (notFound.length > 0) {
        return {
          content: `Hash anchors not found: ${notFound.map(m => m.hash).join(', ')}`,
          isError: true,
        };
      }

      const modified = applyEdits(content, matches);
      await writeFile(absolutePath, modified, 'utf-8');

      return { content: `Applied ${edits.length} hashline edits to ${path}` };
    } catch (error) {
      return { content: `Error: ${error}`, isError: true };
    }
  },
};
