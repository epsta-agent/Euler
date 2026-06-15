/**
 * Edit tool - Edit files with search/replace.
 *
 * Junior-model friendly: requires an exact, unambiguous `oldText` anchor. If
 * the anchor is missing OR appears more than once, the tool refuses with an
 * actionable message so the model can include more surrounding context. This
 * keeps edits deterministic — the #1 source of weak-model edit failures is an
 * ambiguous match that silently mutates the wrong location.
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool, ToolResult } from './types.ts';

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

/** Return up to `n` snippets of context around each match, for error messages. */
function contextSnippets(haystack: string, needle: string, n = 2): string[] {
  const out: string[] = [];
  let i = 0;
  while (out.length < n && (i = haystack.indexOf(needle, i)) !== -1) {
    const start = Math.max(0, i - 20);
    const end = Math.min(haystack.length, i + needle.length + 20);
    out.push('…' + haystack.slice(start, end).replace(/\n/g, '\\n') + '…');
    i += needle.length;
  }
  return out;
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Edit a file by replacing an EXACT, unambiguous block of text. ' +
    'oldText must match exactly once; if it matches zero or multiple times the ' +
    'edit is rejected with a message telling you to add more surrounding context.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      oldText: { type: 'string', description: 'The exact text to replace (must be unique in the file)' },
      newText: { type: 'string', description: 'New text to insert in place of oldText' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  execute: async (input): Promise<ToolResult> => {
    const { path, oldText, newText } = input as { path: string; oldText: string; newText: string };

    try {
      const absolutePath = resolve(process.cwd(), path);
      const content = await readFile(absolutePath, 'utf-8');

      const matches = countOccurrences(content, oldText);
      if (matches === 0) {
        // Surface the first few lines of the file so the model can re-anchor
        // oldText without burning a separate `read` round-trip. This is the
        // common failure on weak models that mis-remember indentation/whitespace.
        const lines = content.split('\n').slice(0, 8);
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
        return {
          content:
            `Error: oldText not found in file. The text must match exactly — indentation, whitespace, and newlines all matter. ` +
            `Here are the first lines of the file to help you re-anchor:\n${numbered}\n\n` +
            `Tip: call read() on this file first to copy the exact text you want to replace.`,
          isError: true,
        };
      }
      if (matches > 1) {
        const snippets = contextSnippets(content, oldText).map((s, idx) => `  match ${idx + 1}: ${s}`).join('\n');
        return {
          content:
            `Error: oldText is ambiguous (matched ${matches} times). Add more surrounding lines to oldText so it matches exactly once.\n` +
            `Matches found:\n${snippets}`,
          isError: true,
        };
      }

      const newContent = content.replace(oldText, newText);
      await writeFile(absolutePath, newContent, 'utf-8');

      return { isError: false, content: `Successfully edited ${path}` };
    } catch (error: any) {
      const msg = error?.code === 'ENOENT'
        ? `Error editing file: file not found at '${path}'`
        : `Error editing file: ${error?.message ?? error}`;
      return { content: msg, isError: true };
    }
  },
};

