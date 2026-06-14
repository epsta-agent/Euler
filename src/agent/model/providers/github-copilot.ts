/**
 * GitHub Copilot (coding plan) provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class GitHubCopilotProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.GITHUB_TOKEN,
      baseURL: 'https://api.githubcopilot.com/copilot-internal/v1',
    });
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: (chunk: StreamChunk) => void,
    options: StreamOptions = {}
  ): Promise<void> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
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
