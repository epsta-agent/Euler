/**
 * OpenRouter provider - supports many models via OpenRouter API
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamCallback, StreamChunk } from '../types.ts';

export class OpenRouterProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || '',
      baseURL: 'https://openrouter.ai/api/v1',
    });
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
      const stream = await this.client.chat.completions.create(
        {
          model: 'anthropic/claude-3.5-sonnet',
          max_tokens: maxTokens,
          temperature,
          messages: [
            ...(system ? [{ role: 'system' as const, content: system }] : []),
            ...chatMessages.map(m => ({
              role: m.role as 'user' | 'assistant',
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
          ],
          tools: tools.length > 0 ? tools.map(this.convertTool) : undefined,
          stream: true,
        },
        { signal: signal as any },
      );

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          onChunk({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: delta.content },
          });
        }
        if (chunk.choices[0]?.finish_reason) {
          onChunk({ type: 'message_stop' });
        }
      }
    } catch (error) {
      if ((error as any).status === 401) {
        throw new Error('OpenRouter API key invalid or missing');
      }
      throw error;
    }
  }

  private convertTool(tool: any): any {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }
}
