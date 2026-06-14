/**
 * Cloudflare Workers AI provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class CloudflareWorkersAIProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

    if (!accountId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID is required for Cloudflare Workers AI');
    }

    this.client = new OpenAI({
      apiKey: apiKey || process.env.CLOUDFLARE_API_KEY,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/workers-ai`,
      defaultHeaders: {
        'x-session-affinity': 'true', // Enable prefix caching discounts
      },
    });
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: (chunk: StreamChunk) => void,
    options: StreamOptions = {}
  ): Promise<void> {
    const { temperature = 0.7, maxTokens = 4096 } = options;

    const system = messages.find(m => m.role === 'system')?.content as string || '';
    const chatMessages = messages.filter(m => m.role !== 'system');

    // Workers AI uses prefixed model IDs like @cf/moonshotai/kimi-k2.6
    const response = await this.client.chat.completions.create({
      model: options.model || '@cf/meta/llama-3.1-70b-instruct',
      max_tokens: maxTokens,
      temperature,
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        ...chatMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      ] as any,
      stream: true,
    });

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta.content } });
      }
      if (chunk.choices[0]?.finish_reason) {
        onChunk({ type: 'message_stop' });
      }
    }
  }
}
