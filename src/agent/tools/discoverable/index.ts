/**
 * Discoverable tools - Phase 2 & 3 implementation
 * These tools are activated on-demand via discover_tool
 */

import { toolRegistry } from '../registry';
import { lspTool } from './lsp';
import { debugTool } from './debug';
import { webSearchTool } from './web-search';
import { evalTool } from './eval';
import { taskTool } from './task';
import { astEditTool } from './ast-edit';
import { recipeTool } from './recipe';
import { findTool } from './find';

// Register discoverable tools
export function registerDiscoverableTools(): void {
  toolRegistry.register(lspTool);
  toolRegistry.register(debugTool);
  toolRegistry.register(webSearchTool);
  toolRegistry.register(evalTool);
  toolRegistry.register(taskTool);
  toolRegistry.register(astEditTool);
  toolRegistry.register(recipeTool);
  toolRegistry.register(findTool);
}

// Export individual tools
export {
  lspTool,
  debugTool,
  webSearchTool,
  evalTool,
  taskTool,
  astEditTool,
  recipeTool,
  findTool
};

// Re-export types
export * from '../types';
