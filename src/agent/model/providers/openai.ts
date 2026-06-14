/**
 * OpenAI provider - flattened implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamCallback } from '../types';

function convertContentBlocks(blocks: any[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      const url = block.source.type === 'base64'
        ? `data:${block.source.media_type};base64,${block.source.data}`
        : block.source.data;
      return { type: 'image_url', image_url: { url } };
    }
    return block;
  }).join('\n');
}

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

export class OpenAIProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
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
      const stream = await this.client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: maxTokens,
        temperature,
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          ...chatMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : convertContentBlocks(m.content),
          })),
        ],
        tools: tools.length > 0 ? tools.map(convertToolDefinition) : undefined,
        stream: true,
      }, { signal: signal as any });

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta.content } });
        }
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.function?.arguments) {
              onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: toolCall.function.arguments } });
            }
          }
        }
        if (chunk.choices[0]?.finish_reason) {
          onChunk({ type: 'message_stop' });
        }
      }
    } catch (error: any) {
      if (error?.status === 401) {
        throw new Error('OpenAI API key invalid or missing');
      }
      throw error;
    }
  }
}
