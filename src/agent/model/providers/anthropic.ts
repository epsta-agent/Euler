/**
 * Anthropic provider - flattened implementation
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderInterface, Message, StreamOptions, StreamCallback } from '../types';

function convertContentBlock(block: any): any {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: block.source.type,
        media_type: block.source.media_type || 'image/png',
        data: block.source.data,
      },
    };
  }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  if (block.type === 'tool_result') {
    return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error };
  }
  return block;
}

function convertToolDefinition(tool: any): any {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function shouldAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function isAuthError(error: any): boolean {
  return error?.status === 401;
}

export class AnthropicProvider implements ProviderInterface {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: StreamCallback,
    options: StreamOptions = {},
  ): Promise<void> {
    const { temperature = 0.7, maxTokens = 8192, signal, headers = {} } = options;

    const system = messages.find(m => m.role === 'system')?.content as string || '';
    const chatMessages = messages.filter(m => m.role !== 'system');

    try {
      const response = await this.client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: chatMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : m.content.map(convertContentBlock),
        })),
        tools: tools.length > 0 ? tools.map(convertToolDefinition) : undefined,
        stream: true,
      }, { signal: signal as any, headers });

      for await (const chunk of response) {
        if (shouldAbort(signal)) break;

        switch (chunk.type) {
          case 'content_block_delta':
            if (chunk.delta.type === 'text_delta') {
              onChunk({
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: chunk.delta.text },
                index: chunk.index,
              });
            }
            break;
          case 'content_block_stop':
            onChunk({ type: 'content_block_stop', index: chunk.index });
            break;
          case 'message_delta':
            onChunk({ type: 'message_delta' });
            break;
          case 'message_stop':
            onChunk({ type: 'message_stop' });
            break;
        }
      }
    } catch (error: any) {
      if (isAuthError(error)) {
        throw new Error('Anthropic API key invalid or missing');
      }
      throw error;
    }
  }
}
