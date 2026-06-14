/**
 * Ollama (local) provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class OllamaProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || 'ollama', // Ollama doesn't need a real API key
      baseURL: 'http://localhost:11434/v1',
    });
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: (chunk: StreamChunk) => void,
    options: StreamOptions = {}
  ): Promise<void> {
    const response = await this.client.chat.completions.create({
      model: 'llama3:latest',
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })) as any,
      stream: true,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096,
    });

    for await (const chunk of response) {
      if (chunk.choices[0]?.delta?.content) {
        onChunk({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: chunk.choices[0].delta.content },
        });
      } else if (chunk.choices[0]?.finish_reason) {
        onChunk({ type: 'message_stop' });
      }
    }
  }
}
