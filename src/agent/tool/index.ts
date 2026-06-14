/**
 * Complete tool registry with all tools from oh-my-pi
 */

export type { Tool, ToolResult, ToolInput } from './types';

// Core file tools
export { readTool } from './read';
export { writeTool } from './write';
export { editTool } from './edit';
export { hashlineEditTool } from './hashline';

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

import type { Tool } from './types';
import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { hashlineEditTool } from './hashline';
import { searchTool } from './search';
import { findTool } from './find';
import { grepTool } from './grep';
import { bashTool } from './bash';
import { evalTool } from './eval';
import { lspTool } from './lsp';
import { taskTool } from './task';

export const tools: Tool[] = [
  // File operations
  readTool,
  writeTool,
  editTool,
  hashlineEditTool,

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
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export function getToolsByCategory(category: 'file' | 'search' | 'execution' | 'intelligence' | 'coordination'): Tool[] {
  const categoryMap: Record<string, string[]> = {
    file: ['read', 'write', 'edit', 'hashline_edit'],
    search: ['search', 'find', 'grep'],
    execution: ['bash', 'eval'],
    intelligence: ['lsp'],
    coordination: ['task'],
  };

  const names = categoryMap[category] || [];
  return names.map(name => getTool(name)).filter((t): t is Tool => t !== undefined);
}
