/**
 * Azure OpenAI provider implementation
 */

import OpenAI from 'openai';
import type { ProviderInterface, Message, StreamOptions, StreamChunk } from '../types';

export class AzureOpenAIProvider implements ProviderInterface {
  private client: OpenAI;

  constructor(apiKey?: string) {
    const baseUrl = process.env.AZURE_OPENAI_BASE_URL ||
      `https://${process.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`;

    this.client = new OpenAI({
      apiKey: apiKey || process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${baseUrl}/openai/v1`,
      defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-02-01' },
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

    const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    const model = options.model || 'gpt-4o';

    // Map model names to deployment names if configured
    const finalModel = deploymentMap ? this.mapDeploymentName(model, deploymentMap) : model;

    const response = await this.client.chat.completions.create({
      model: finalModel,
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

  private mapDeploymentName(model: string, map: string): string {
    const entries = map.split(',');
    for (const entry of entries) {
      const [baseModel, deployment] = entry.split('=');
      if (baseModel === model) return deployment;
    }
    return model;
  }
}
