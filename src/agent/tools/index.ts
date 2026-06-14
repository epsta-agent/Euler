/**
 * Tools system - following oh-my-pi architecture
 * Lazy tool loading with discovery mechanism
 */

import { toolRegistry } from './registry';
import { registerCoreTools } from './core';
import { registerDiscoverableTools } from './discoverable';

// Register core tools on module load
registerCoreTools();
registerDiscoverableTools();

// Export registry and types
export { toolRegistry } from './registry';
export * from './types';
export * from './core';
export * from './discoverable';

// Tool initialization helper
export function initializeTools(): void {
  // All tools are already registered
  const core = toolRegistry.getByCategory('core').map(t => t.name);
  const discoverable = toolRegistry.getByCategory('discoverable').map(t => t.name);

  console.log('Core tools registered:', core);
  console.log('Discoverable tools registered:', discoverable);
}

// Get tool function for agent use
export function getTool(name: string) {
  return toolRegistry.get(name);
}

// Get all active tools (core + activated)
export function getActiveTools() {
  return toolRegistry.getActive();
}

// Discover and activate tools
export function discoverTools(query: string, limit?: number) {
  return toolRegistry.discover(query, limit);
}

// Activate a tool
export function activateTool(name: string): boolean {
  return toolRegistry.activate(name);
}
