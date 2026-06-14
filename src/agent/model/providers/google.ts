/**
 * Google provider - flattened implementation
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ProviderInterface, Message, StreamOptions, StreamCallback } from '../types';

export class GoogleProvider implements ProviderInterface {
  private client: GoogleGenerativeAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenerativeAI(apiKey || '');
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: StreamCallback,
    options: StreamOptions = {},
  ): Promise<void> {
    const { temperature = 0.7, maxTokens = 8192, signal } = options;

    const system = messages.find(m => m.role === 'system')?.content as string || '';
    const chatMessages = messages.filter(m => m.role !== 'system');

    try {
      const model = this.client.getGenerativeModel({
        model: 'gemini-1.5-pro',
        systemInstruction: system || undefined,
      });

      const history = chatMessages.slice(0, -1).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));

      const lastMessage = chatMessages[chatMessages.length - 1];
      const prompt = typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content);

      const result = await model.generateContentStream({
        contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
      });

      for await (const chunk of result.stream) {
        if (signal?.aborted) break;

        const text = chunk.text();
        if (text) {
          onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
        }
      }

      onChunk({ type: 'message_stop' });
    } catch (error: any) {
      if (error?.status === 401) {
        throw new Error('Google API key invalid or missing');
      }
      throw error;
    }
  }
}
