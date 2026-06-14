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
  /**
   * API key for the model. When set together with `baseUrl`, the coordinator
   * runs the real tool-use loop against an OpenAI-compatible endpoint. The
   * agent itself never hardcodes a key; the caller (TUI / SDK / bench) supplies
   * one from the user's environment.
   */
  apiKey?: string;
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl?: string;
  /** Max tool-use round trips before forcing a final answer. */
  maxToolRounds?: number;
  /**
   * Optional callback invoked before each model call. If it returns a string,
   * that string is appended as a user message before the call — useful for
   * progress nudges ("you haven't written any file yet").
   */
  onBeforeModelCall?: (ctx: {
    round: number;
    toolsCalled: string[];
    messageCount: number;
  }) => string | undefined;
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

// Re-export to satisfy existing imports that reference these symbols.
export type { Tool, ToolResult };
