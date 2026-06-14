/**
 * Agent layer types
 */

import type { Tool, ToolResult } from '../tool/types';

export interface AgentConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AgentEvent {
  type: 'message' | 'stream_end' | 'tool_start' | 'tool_end' | 'done' | 'error';
  data?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
