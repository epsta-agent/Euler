/**
 * TUI types for Euler Agent
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  name: string;
  input: Record<string, any>;
  output?: any;
}

export interface TUIState {
  messages: ChatMessage[];
  input: string;
  status: 'idle' | 'processing' | 'error' | 'plan';
  error?: string;
  provider?: string;
  model?: string;
  compacted?: number;
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  planMode?: boolean;
}
