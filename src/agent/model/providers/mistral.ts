/**
 * Mistral provider - flattened implementation
 */

import { Mistral } from '@mistralai/mistralai';
import type { ProviderInterface, Message, StreamOptions, StreamCallback } from '../types';

function convertToolDefinition(tool: any): any {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export class MistralProvider implements ProviderInterface {
  private client: Mistral;

  constructor(apiKey?: string) {
    this.client = new Mistral({ apiKey: apiKey || '' });
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: StreamCallback,
    options: StreamOptions = {},
  ): Promise<void> {
    const { temperature = 0.7, maxTokens = 4096, signal } = options;

    const system = messages.find(m => m.role === 'system')?.content as string || '';
    const chatMessages = messages.filter(m => m.role !== 'system');

    try {
      const stream = await this.client.chat.stream({
        model: 'mistral-large-latest',
        maxTokens,
        temperature,
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          ...chatMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
        ],
        tools: tools.length > 0 ? tools.map(convertToolDefinition) : undefined,
      });

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const delta = chunk.data.choices[0]?.delta;

        if (delta && typeof delta === 'string') {
          onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta } });
        }
        if (chunk.data.choices[0]?.finishReason) {
          onChunk({ type: 'message_stop' });
        }
      }
    } catch (error: any) {
      if (error?.status === 401) {
        throw new Error('Mistral API key invalid or missing');
      }
      throw error;
    }
  }
}
