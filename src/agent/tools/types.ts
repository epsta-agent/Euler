/**
 * Tool system types - following oh-my-pi architecture
 */

export interface Tool {
  name: string;
  description: string;
  category: 'core' | 'discoverable' | 'optional';
  parameters: ToolParameter[];
  handler: ToolHandler;
  examples?: ToolExample[];
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  default?: any;
}

export interface ToolExample {
  input: Record<string, any>;
  output: any;
  description: string;
}

export type ToolHandler = (input: Record<string, any>) => Promise<ToolResult>;

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ToolRegistry {
  // Core tools (always loaded)
  core: Map<string, Tool>;

  // Discoverable tools (on-demand)
  discoverable: Map<string, Tool>;

  // Optional tools (specialized)
  optional: Map<string, Tool>;

  // Get tool by name
  get(name: string): Tool | undefined;

  // Discover tools based on query
  discover(query: string, limit?: number): Tool[];

  // Get active tools (core + activated)
  getActive(): Tool[];

  // Activate a discoverable tool
  activate(name: string): boolean;
}

export interface ToolDiscovery {
  // BM25 search over tool descriptions
  search(query: string, tools: Tool[], limit?: number): Tool[];
  // Index tools for search
  indexTools(tools: Tool[]): void;
}

export interface ToolExecutionContext {
  sessionId: string;
  workingDirectory: string;
  environment: Record<string, string>;
  permissions: string[];
}
