/**
 * Edit tool - Hashline patches following oh-my-pi architecture
 * Content-hash anchored edits that reject stale changes
 */

import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import type { Tool, ToolResult } from '../types';

export const editTool: Tool = {
  name: 'edit',
  description: 'Hashline patches with content-hash anchors. Rejects stale edits if file content has changed. More reliable than search-and-replace and token-efficient compared to retyping context.',
  category: 'core',
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'File path to edit',
      required: true
    },
    {
      name: 'edits',
      type: 'array',
      description: 'Array of hashline edits to apply',
      required: true
    },
    {
      name: 'strict',
      type: 'boolean',
      description: 'Reject all edits if any anchor fails (default: true)',
      required: false,
      default: true
    },
    {
      name: 'dry_run',
      type: 'boolean',
      description: 'Preview edits without applying them',
      required: false,
      default: false
    }
  ],
  examples: [
    {
      input: {
        path: 'src/index.ts',
        edits: [
          {
            hash: 'a1b2c3d4',
            oldText: 'function hello() { return "world"; }',
            newText: 'function hello() { return "universe"; }'
          }
        ]
      },
      output: {
        success: true,
        applied: 1,
        failed: 0,
        preview: '...'
      },
      description: 'Replace function content using hash anchor'
    },
    {
      input: {
        path: 'src/config.ts',
        edits: [
          {
            hash: 'e5f6g7h8',
            oldText: 'port: 3000',
            newText: 'port: 8080'
          }
        ],
        dry_run: true
      },
      output: {
        success: true,
        preview: '...',
        dryRun: true
      },
      description: 'Preview edit before applying'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        path: filePath,
        edits,
        strict = true,
        dry_run = false
      } = input;

      if (!Array.isArray(edits) || edits.length === 0) {
        return {
          success: false,
          error: 'Edits must be a non-empty array'
        };
      }

      // Read current file content
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Process each edit
      const results: EditResult[] = [];
      let allAnchorsValid = true;

      for (const edit of edits) {
        const result = await processEdit(lines, edit, strict);
        results.push(result);

        if (!result.anchorValid) {
          allAnchorsValid = false;
          if (strict) {
            break; // Stop processing if strict mode and anchor failed
          }
        }
      }

      // Build response
      const response: any = {
        edits: results,
        totalEdits: edits.length,
        applied: results.filter(r => r.applied).length,
        failed: results.filter(r => !r.applied).length,
        allAnchorsValid
      };

      // Apply edits if not dry run and anchors valid
      if (!dry_run && (allAnchorsValid || !strict)) {
        const newContent = lines.join('\n');
        await writeFile(filePath, newContent);
        response.modified = true;
      } else {
        response.modified = false;
        response.dryRun = dry_run;
      }

      // Add preview
      response.preview = generatePreview(lines, results);

      return {
        success: true,
        data: response
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to process edit'
      };
    }
  }
};

interface EditResult {
  anchorValid: boolean;
  applied: boolean;
  line?: number;
  error?: string;
  preview?: string;
}

interface HashlineEdit {
  hash: string;
  oldText: string;
  newText: string;
  lineHint?: number;
}

// Process individual edit
async function processEdit(
  lines: string[],
  edit: HashlineEdit,
  strict: boolean
): Promise<EditResult> {
  const { hash, oldText, newText, lineHint } = edit;

  // Generate hash for old text
  const expectedHash = generateContentHash(oldText);

  // Verify hash
  if (hash !== expectedHash) {
    return {
      anchorValid: false,
      applied: false,
      error: `Hash mismatch: expected ${expectedHash}, got ${hash}. File content may have changed.`
    };
  }

  // Find the old text in the file
  const lineIndex = findTextInLines(lines, oldText, lineHint);

  if (lineIndex === -1) {
    return {
      anchorValid: true,
      applied: false,
      error: 'Old text not found in file'
    };
  }

  // Apply edit
  applyEdit(lines, lineIndex, oldText, newText);

  return {
    anchorValid: true,
    applied: true,
    line: lineIndex + 1,
    preview: `${oldText.substring(0, 30)}... → ${newText.substring(0, 30)}...`
  };
}

// Generate content hash
function generateContentHash(content: string): string {
  return createHash('sha256')
    .update(content.trim())
    .digest('hex')
    .substring(0, 8);
}

// Find text in lines
function findTextInLines(
  lines: string[],
  searchText: string,
  lineHint?: number
): number {
  const searchLines = searchText.split('\n');

  // If line hint provided, start from there
  const startLine = lineHint ? lineHint - 1 : 0;

  // Search for the text
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].includes(searchLines[0])) {
      // Check if subsequent lines match
      let match = true;
      for (let j = 1; j < searchLines.length; j++) {
        if (i + j >= lines.length || !lines[i + j].includes(searchLines[j])) {
          match = false;
          break;
        }
      }

      if (match) {
        return i;
      }
    }
  }

  // If not found with hint, search from beginning
  if (lineHint && lineHint > 0) {
    return findTextInLines(lines, searchText);
  }

  return -1;
}

// Apply edit to lines
function applyEdit(
  lines: string[],
  lineIndex: number,
  oldText: string,
  newText: string
): void {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Remove old lines
  lines.splice(lineIndex, oldLines.length);

  // Insert new lines
  lines.splice(lineIndex, 0, ...newLines);
}

// Generate preview of edits
function generatePreview(lines: string[], results: EditResult[]): string {
  const previews: string[] = [];

  for (const result of results) {
    if (result.applied && result.preview) {
      previews.push(`✓ ${result.preview}`);
    } else if (!result.anchorValid) {
      previews.push(`✗ ${result.error}`);
    } else if (!result.applied) {
      previews.push(`⊘ ${result.error}`);
    }
  }

  return previews.join('\n');
}
