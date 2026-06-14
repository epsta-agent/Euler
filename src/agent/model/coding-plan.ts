/**
 * Coding plan provider - subscription-based routing
 */

import type { ProviderInterface, Message, StreamOptions, StreamCallback } from './types';

export class CodingPlanProvider implements ProviderInterface {
  private subscriptionKey: string;
  private planProvider: ProviderInterface;
  private fallbackProvider?: ProviderInterface;

  constructor(
    subscriptionKey: string,
    planProvider: ProviderInterface,
    fallbackProvider?: ProviderInterface
  ) {
    this.subscriptionKey = subscriptionKey;
    this.planProvider = planProvider;
    this.fallbackProvider = fallbackProvider;
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: (chunk: any) => void,
    options: StreamOptions = {},
  ): Promise<void> {
    const { signal, ...opts } = options;

    try {
      await this.planProvider.stream(messages, tools, onChunk, {
        ...opts,
        headers: {
          ...opts.headers,
          'X-Subscription-Key': this.subscriptionKey,
          'X-Plan-Mode': 'coding'
        },
        signal
      });
    } catch (error: any) {
      const isAuthError = error.status === 401 || error.status === 403;

      if (this.fallbackProvider && isAuthError) {
        await this.fallbackProvider.stream(messages, tools, onChunk, opts);
      } else {
        throw error;
      }
    }
  }

  updateSubscription(key: string): void {
    this.subscriptionKey = key;
  }

  setFallback(provider: ProviderInterface): void {
    this.fallbackProvider = provider;
  }
}
