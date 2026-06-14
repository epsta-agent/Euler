/**
 * Agent coordinator - simplified and flattened
 */

import type { ProviderInterface, Message } from '../model/types';
import type { Tool, ToolResult } from '../tool/types';
import type { AgentConfig, AgentEvent } from './types';

function extractSystemMessage(messages: Message[]): string | undefined {
  return messages.find(m => m.role === 'system')?.content as string;
}

function filterChatMessages(messages: Message[]): Message[] {
  return messages.filter(m => m.role !== 'system');
}

function createStreamHandler(
  onChunk: (event: AgentEvent) => void,
  signal?: AbortSignal
): (chunk: any) => void {
  return (chunk: any) => {
    if (signal?.aborted) return;

    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      onChunk({ type: 'message', data: { text: chunk.delta.text, delta: true } });
    } else if (chunk.type === 'message_stop') {
      onChunk({ type: 'stream_end' });
    }
  };
}

export class AgentCoordinator {
  private provider: ProviderInterface;
  private tools: Tool[];
  private config: AgentConfig;
  private eventHandlers = new Set<(event: AgentEvent) => void>();

  constructor(provider: ProviderInterface, tools: Tool[], config: AgentConfig) {
    this.provider = provider;
    this.tools = tools;
    this.config = config;
  }

  onEvent(handler: (event: AgentEvent) => void): void {
    this.eventHandlers.add(handler);
  }

  private emit(event: AgentEvent): void {
    this.eventHandlers.forEach(h => h(event));
  }

  async process(userMessage: string): Promise<string> {
    const messages: Message[] = [
      ...(this.config.systemPrompt
        ? [{ role: 'system' as const, content: this.config.systemPrompt }]
        : []),
      { role: 'user' as const, content: userMessage },
    ];

    let response = '';
    let buffer = '';
    let streamEnded = false;

    const onChunk = (event: AgentEvent) => {
      if (event.type === 'message' && event.data && typeof event.data === 'object' && 'text' in event.data) {
        buffer += (event.data as { text: string }).text;
      }
      if (event.type === 'stream_end') {
        streamEnded = true;
        response = buffer;
      }
    };

    const system = extractSystemMessage(messages);
    const chatMessages = filterChatMessages(messages);

    await this.provider.stream(
      chatMessages,
      this.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      (chunk: any) => createStreamHandler(onChunk, undefined)(chunk),
      { temperature: this.config.temperature, maxTokens: this.config.maxTokens },
    );

    this.emit({ type: 'done', data: { response } });
    return response;
  }

  async executeTool(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.find(t => t.name === toolName);

    if (!tool) {
      return { content: `Tool not found: ${toolName}`, isError: true };
    }

    this.emit({ type: 'tool_start', data: { tool: toolName } });
    const result = await tool.execute(input);
    this.emit({ type: 'tool_end', data: { tool: toolName, result } });

    return result;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
