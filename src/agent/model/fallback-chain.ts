/**
 * Fallback chain - provider failover with cooldown
 */

import type { ProviderInterface, Message, StreamOptions, StreamCallback } from './types';

interface FallbackEntry {
  provider: ProviderInterface;
  name: string;
  cooldownUntil: number;
  errors: number;
}

interface ProviderStatus {
  name: string;
  available: boolean;
  errors: number;
}

function createFallbackEntry(name: string, provider: ProviderInterface): FallbackEntry {
  return { provider, name, cooldownUntil: 0, errors: 0 };
}

function shouldUseProvider(entry: FallbackEntry, now: number): boolean {
  return entry.cooldownUntil <= now;
}

function isRetryableError(error: any): boolean {
  return error.status === 429 || error.status === 503 || error.code === 'ECONNRESET';
}

function calculateCooldown(errors: number, backoffMs: number): number {
  return backoffMs * Math.pow(2, Math.min(errors - 1, 5));
}

export class FallbackChain implements ProviderInterface {
  private providers: FallbackEntry[] = [];
  private currentIndex = 0;
  private backoffMs = 60000;

  constructor(providers: Array<{ name: string; provider: ProviderInterface }>) {
    this.providers = providers.map(p => createFallbackEntry(p.name, p.provider));
  }

  async stream(
    messages: Message[],
    tools: any[],
    onChunk: (chunk: any) => void,
    options: StreamOptions = {},
  ): Promise<void> {
    const now = Date.now();

    for (let i = 0; i < this.providers.length; i++) {
      const entry = this.providers[i];

      if (!shouldUseProvider(entry, now)) continue;

      try {
        await entry.provider.stream(messages, tools, onChunk, options);

        entry.errors = 0;
        this.currentIndex = i;
        return;

      } catch (error: any) {
        entry.errors++;

        if (isRetryableError(error)) {
          const backoff = calculateCooldown(entry.errors, this.backoffMs);
          entry.cooldownUntil = now + backoff;
        }
      }
    }

    throw new Error('All providers in fallback chain failed');
  }

  getCurrentProvider(): string {
    return this.providers[this.currentIndex]?.name || 'none';
  }

  getProvidersStatus(): ProviderStatus[] {
    const now = Date.now();
    return this.providers.map(p => ({
      name: p.name,
      available: p.cooldownUntil <= now,
      errors: p.errors,
    }));
  }

  setBackoff(ms: number): void {
    this.backoffMs = ms;
  }

  resetCooldowns(): void {
    const now = Date.now();
    for (const entry of this.providers) {
      entry.cooldownUntil = 0;
    }
  }
}
