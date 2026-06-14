/**
 * Google Vertex AI provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class GoogleVertexProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    if (!project) {
      throw new Error('GOOGLE_CLOUD_PROJECT is required for Google Vertex AI');
    }

    // Check for Application Default Credentials
    const hasCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                          process.env.GOOGLE_CLOUD_ACCESS_TOKEN;

    if (!hasCredentials) {
      throw new Error('Google credentials required. Set GOOGLE_APPLICATION_CREDENTIALS or authenticate with gcloud auth application-default login');
    }

    this.client = new OpenAI({
      baseURL: `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}`,
      apiKey: apiKey || process.env.GOOGLE_CLOUD_ACCESS_TOKEN,
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

    // Vertex AI uses specific model names
    const model = options.model || 'gemini-2.0-flash-exp';

    const response = await this.client.chat.completions.create({
      model: `publishers/google/models/${model}`,
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
