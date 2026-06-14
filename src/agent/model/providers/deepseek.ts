/**
 * DeepSeek provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class DeepSeekProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
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
      model: 'deepseek-chat',
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
