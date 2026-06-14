/**
 * Core tools - Phase 1 implementation
 * These tools are always available in the agent context
 */

import { toolRegistry } from '../registry';
import { readTool } from './read';
import { writeTool } from './write';
import { editTool } from './edit';
import { bashTool } from './bash';
import { searchTool } from './search';
import { discoverTool } from './discover-tool';

// Register all core tools
export function registerCoreTools(): void {
  toolRegistry.register(readTool);
  toolRegistry.register(writeTool);
  toolRegistry.register(editTool);
  toolRegistry.register(bashTool);
  toolRegistry.register(searchTool);
  toolRegistry.register(discoverTool);
}

// Export individual tools
export {
  readTool,
  writeTool,
  editTool,
  bashTool,
  searchTool,
  discoverTool
};

// Re-export types
export * from '../types';
