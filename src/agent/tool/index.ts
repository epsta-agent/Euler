/**
 * Complete tool registry.
 *
 * hashline_edit was removed: it advertised a hash-anchor contract the system
 * prompt leaned on heavily, but the model cannot compute the line-hashes the
 * tool required, so it failed by design. `edit` (exact-match search/replace)
 * is the single editing path now.
 */

export type { Tool, ToolResult, ToolInput } from './types';

// Core file tools
export { readTool } from './read';
export { writeTool } from './write';
export { editTool } from './edit';
export { lsTool } from './ls';
export { globTool } from './glob';

// Search tools
export { searchTool } from './search';
export { findTool } from './find';
export { grepTool } from './grep';

// Execution tools
export { bashTool } from './bash';
export { evalTool } from './eval';

// Code intelligence
export { lspTool } from './lsp';

// Coordination
export { taskTool } from './task';

// Specialist tools (latex_check, run_tests, inspect_env, hex_dump, diff_files)
export { localSpecialistTools, makeSpecialistTools } from './specialist';
export type { ExecFn, ExecResult } from './specialist';

import type { Tool } from './types';
import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { lsTool } from './ls';
import { globTool } from './glob';
import { searchTool } from './search';
import { findTool } from './find';
import { grepTool } from './grep';
import { bashTool } from './bash';
import { evalTool } from './eval';
import { lspTool } from './lsp';
import { taskTool } from './task';
import { localSpecialistTools } from './specialist';

export const tools: Tool[] = [
  // File operations
  readTool,
  writeTool,
  editTool,
  lsTool,
  globTool,

  // Search
  searchTool,
  findTool,
  grepTool,

  // Execution
  bashTool,
  evalTool,

  // Code intelligence
  lspTool,

  // Coordination
  taskTool,

  // Specialist (structured single-call tools that replace multi-step bash rituals)
  ...localSpecialistTools(),
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export function getToolsByCategory(category: 'file' | 'search' | 'execution' | 'intelligence' | 'coordination'): Tool[] {
  const categoryMap: Record<string, string[]> = {
    file: ['read', 'write', 'edit', 'ls', 'glob'],
    search: ['search', 'find', 'grep'],
    execution: ['bash', 'eval'],
    intelligence: ['lsp'],
    coordination: ['task'],
  };

  const names = categoryMap[category] || [];
  return names.map(name => getTool(name)).filter((t): t is Tool => t !== undefined);
}
