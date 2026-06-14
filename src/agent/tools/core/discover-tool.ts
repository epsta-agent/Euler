/**
 * Discover tool - Meta-tool for finding and activating tools
 * Following oh-my-pi's tool discovery architecture
 */

import { toolRegistry } from '../registry';
import type { Tool, ToolResult } from '../types';

export const discoverTool: Tool = {
  name: 'discover_tool',
  description: 'Meta-tool for discovering and activating additional tools on-demand. Search the tool registry by query and activate tools when needed. Keeps initial context small while allowing access to specialized capabilities.',
  category: 'core',
  parameters: [
    {
      name: 'query',
      type: 'string',
      description: 'Search query to find relevant tools (e.g., "debug", "web search", "code execution")',
      required: true
    },
    {
      name: 'activate',
      type: 'string',
      description: 'Tool name to activate (optional - if not provided, returns search results)',
      required: false
    },
    {
      name: 'limit',
      type: 'number',
      description: 'Maximum number of results to return (default: 5)',
      required: false,
      default: 5
    },
    {
      name: 'list_all',
      type: 'boolean',
      description: 'List all available tools by category (default: false)',
      required: false,
      default: false
    }
  ],
  examples: [
    {
      input: {
        query: 'debug code breakpoint'
      },
      output: {
        success: true,
        tools: [
          {
            name: 'debug',
            description: 'Drive DAP sessions - breakpoints, stepping, threads, stack, variables',
            category: 'discoverable'
          }
        ]
      },
      description: 'Search for debugging tools'
    },
    {
      input: {
        activate: 'debug'
      },
      output: {
        success: true,
        activated: true,
        tool: 'debug',
        message: 'Tool "debug" has been activated'
      },
      description: 'Activate a specific tool'
    },
    {
      input: {
        list_all: true
      },
      output: {
        success: true,
        core: ['read', 'write', 'edit', 'bash', 'search', 'discover_tool'],
        discoverable: ['lsp', 'debug', 'web_search', 'eval', 'task', 'ast_edit', 'recipe', 'find'],
        optional: ['browser', 'generate_image', 'github']
      },
      description: 'List all available tools by category'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const { query, activate, limit = 5, list_all = false } = input;

      // List all tools
      if (list_all) {
        return listAllTools();
      }

      // Activate specific tool
      if (activate) {
        return activateTool(activate);
      }

      // Search for tools by query
      if (!query) {
        return {
          success: false,
          error: 'Must provide either "query", "activate", or "list_all"'
        };
      }

      return searchTools(query, limit);

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Tool discovery failed'
      };
    }
  }
};

// List all tools by category
function listAllTools(): ToolResult {
  const core = toolRegistry.getByCategory('core');
  const discoverable = toolRegistry.getByCategory('discoverable');
  const optional = toolRegistry.getByCategory('optional');

  return {
    success: true,
    data: {
      core: core.map(t => t.name),
      discoverable: discoverable.map(t => t.name),
      optional: optional.map(t => t.name),
      summary: {
        core: core.length,
        discoverable: discoverable.length,
        optional: optional.length,
        total: core.length + discoverable.length + optional.length
      }
    }
  };
}

// Activate specific tool
function activateTool(toolName: string): ToolResult {
  const tool = toolRegistry.get(toolName);

  if (!tool) {
    return {
      success: false,
      error: `Tool "${toolName}" not found in registry`
    };
  }

  // Check if already active (core tools are always active)
  const isActive = tool.category === 'core';
  if (isActive) {
    return {
      success: true,
      data: {
        tool: toolName,
        activated: false,
        alreadyActive: true,
        category: tool.category,
        message: `Tool "${toolName}" is already active (core tool)`
      }
    };
  }

  // Activate the tool
  const activated = toolRegistry.activate(toolName);

  if (activated) {
    return {
      success: true,
      data: {
        tool: toolName,
        activated: true,
        category: tool.category,
        message: `Tool "${toolName}" has been activated and is now available`,
        description: tool.description,
        parameters: tool.parameters
      }
    };
  }

  return {
    success: false,
    error: `Failed to activate tool "${toolName}"`
  };
}

// Search for tools by query
function searchTools(query: string, limit: number): ToolResult {
  const discoveredTools = toolRegistry.discover(query, limit);

  if (discoveredTools.length === 0) {
    return {
      success: true,
      data: {
        tools: [],
        query,
        message: `No tools found for query "${query}"`,
        suggestion: 'Try "list_all: true" to see all available tools'
      }
    };
  }

  return {
    success: true,
    data: {
      tools: discoveredTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        // Suggest activation command
        activation: `discover_tool(activate: "${tool.name}")`
      })),
      query,
      found: discoveredTools.length,
      message: `Found ${discoveredTools.length} tool(s) for query "${query}"`
    }
  };
}

// Get currently active tools
export function getActiveTools(): Tool[] {
  return toolRegistry.getActive();
}

// Check if tool is active
export function isToolActive(toolName: string): boolean {
  const activeTools = getActiveTools();
  return activeTools.some(t => t.name === toolName);
}
