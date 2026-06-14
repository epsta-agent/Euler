/**
 * Core types for Euler Agent
 */

/** Message role in conversation */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Content type in messages */
export type ContentType = 'text' | 'image' | 'tool_use' | 'tool_result';

/** Base message interface */
export interface Message {
  role: MessageRole;
  content: Content[];
  timestamp?: number;
}

/** Text content */
export interface TextContent {
  type: 'text';
  text: string;
}

/** Image content */
export interface ImageContent {
  type: 'image';
  source: ImageSource;
}

export interface ImageSource {
  type: 'url' | 'base64';
  data: string;
  media_type?: string;
}

/** Tool use content */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool result content */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Union type for all content types */
export type Content = TextContent | ImageContent | ToolUseContent | ToolResultContent;

/** Tool definition */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tool execution result */
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** Agent configuration */
export interface AgentConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** Session metadata */
export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  name?: string;
  model: string;
}
