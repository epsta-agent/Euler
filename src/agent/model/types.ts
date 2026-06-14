/**
 * Model layer types - comprehensive provider support like oh-my-pi
 */

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'google-vertex'
  | 'mistral'
  | 'azure-openai'
  | 'amazon-bedrock'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'deepseek'
  | 'openai-codex'
  | 'cohere'
  | 'perplexity'
  | 'fireworks'
  | 'together'
  | 'huggingface'
  | 'cursor'
  | 'github-copilot'
  | 'ollama'
  | 'lm-studio'
  | 'vllm'
  | 'cerebras'
  | 'cloudflare-ai-gateway'
  | 'cloudflare-workers-ai'
  | 'vercel-ai-gateway'
  | 'zai'
  | 'opencode'
  | 'opencode-go'
  | 'kimi-coding'
  | 'minimax'
  | 'minimax-cn'
  | 'xiaomi'
  | 'xiaomi-token-plan-cn'
  | 'xiaomi-token-plan-ams'
  | 'xiaomi-token-plan-sgp';

export type Api =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'mistral-conversations'
  | 'azure-openai-responses'
  | 'openai-codex-responses'
  | 'bedrock-converse-stream';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'url' | 'base64'; data: string; media_type?: string } };

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  model?: string;
}

export interface Model<TApi extends Api = Api> {
  provider: Provider;
  api: TApi;
  id: string;
  name: string;
}

export interface StreamChunk {
  type: 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  delta?: { type: 'text_delta'; text: string };
  index?: number;
}

export type StreamCallback = (chunk: StreamChunk) => void;

/** Provider interface - all providers implement this */
export interface ProviderInterface {
  stream(
    messages: Message[],
    tools: any[],
    onChunk: StreamCallback,
    options: StreamOptions,
  ): Promise<void>;
}

/** Provider registry */
export interface ProviderRegistry {
  register(provider: Provider, factory: () => ProviderInterface): void;
  get(provider: Provider): ProviderInterface | undefined;
  list(): Provider[];
}
