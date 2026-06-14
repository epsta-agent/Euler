/**
 * Amazon Bedrock provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class AmazonBedrockProvider implements ProviderInterface {
  private client: OpenAI;
  private region: string;

  constructor(apiKey?: string) {
    this.region = process.env.AWS_REGION || 'us-east-1';

    // Check for AWS credentials
    const hasCredentials = process.env.AWS_PROFILE ||
                          process.env.AWS_ACCESS_KEY_ID ||
                          process.env.AWS_BEARER_TOKEN_BEDROCK;

    if (!hasCredentials) {
      throw new Error('AWS credentials required. Set AWS_PROFILE, AWS_ACCESS_KEY_ID, or AWS_BEARER_TOKEN_BEDROCK');
    }

    // Check for proxy or standard endpoint
    const endpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME ||
                    `https://bedrock-runtime.${this.region}.amazonaws.com`;

    this.client = new OpenAI({
      baseURL: endpoint,
      apiKey: 'aws-bedrock', // Placeholder, actual auth handled via headers
      defaultHeaders: {
        'Authorization': this.getAuthHeader(),
      },
    });
  }

  private getAuthHeader(): string {
    // This is a simplified version - in production, use AWS SDK for proper signing
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      return `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
    }

    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      // In production, this would need AWS Signature V4
      return `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}`;
    }

    throw new Error('Cannot determine AWS authentication method');
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

    // Bedrock uses specific model ARNs or model IDs
    const model = options.model || 'us.anthropic.claude-sonnet-4-20250514-v1:0';

    const response = await this.client.chat.completions.create({
      model,
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
