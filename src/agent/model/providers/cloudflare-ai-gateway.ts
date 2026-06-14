/**
 * Cloudflare AI Gateway provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class CloudflareAIGatewayProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID;

    if (!accountId || !gatewayId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID are required for Cloudflare AI Gateway');
    }

    this.client = new OpenAI({
      apiKey: apiKey || process.env.CLOUDFLARE_API_KEY,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`,
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

    const response = await this.client.chat.completions.create({
      model: options.model || 'gpt-4o',
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
