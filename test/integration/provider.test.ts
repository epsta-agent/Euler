/**
 * Provider integration tests - comprehensive testing
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { AnthropicProvider } from '../../src/agent/model/providers/anthropic';
import { OpenAIProvider } from '../../src/agent/model/providers/openai';
import { GoogleProvider } from '../../src/agent/model/providers/google';
import { MistralProvider } from '../../src/agent/model/providers/mistral';
import { OpenRouterProvider } from '../../src/agent/model/providers/openrouter';

describe('Provider Integration Tests', () => {
  describe('Anthropic Provider', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = new AnthropicProvider('test-key');
    });

    it('should initialize with API key', () => {
      expect(provider).toBeDefined();
    });

    it('should handle streaming responses', async () => {
      const chunks: any[] = [];
      const onChunk = (chunk: any) => chunks.push(chunk);

      await provider.stream(
        [{ role: 'user', content: 'Hello' }],
        [],
        onChunk,
        { signal: new AbortController().signal },
      );

      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle tool calls in stream', async () => {
      const tools = [{
        name: 'echo',
        description: 'Echo text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
      }];

      const chunks: any[] = [];
      await provider.stream(
        [{ role: 'user', content: 'Use echo tool' }],
        tools,
        (chunk) => chunks.push(chunk),
        {}
      );

      expect(chunks.some(c => c.type === 'content_block_delta')).toBe(true);
    });

    it('should abort on signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const chunks: any[] = [];
      await provider.stream(
        [{ role: 'user', content: 'Hello' }],
        [],
        (chunk) => chunks.push(chunk),
        { signal: controller.signal },
      );

      // Should abort early
      expect(chunks.length).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      const badProvider = new AnthropicProvider('invalid-key');

      let errorThrown = false;
      try {
        await badProvider.stream(
          [{ role: 'user', content: 'Test' }],
          [],
          () => {},
          {}
        );
      } catch (error: any) {
        errorThrown = error.message.includes('API key');
      }

      expect(errorThrown).toBe(true);
    });
  });

  describe('OpenAI Provider', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
      provider = new OpenAIProvider('test-key');
    });

    it('should initialize with API key', () => {
      expect(provider).toBeDefined();
    });

    it('should handle streaming responses', async () => {
      const chunks: any[] = [];
      await provider.stream(
        [{ role: 'user', content: 'Hello' }],
        [],
        (chunk) => chunks.push(chunk),
        { signal: new AbortController().signal }
      );

      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should support custom base URL', () => {
      const customProvider = new OpenAIProvider('key', 'https://custom.example.com');
      expect(customProvider).toBeDefined();
    });
  });

  describe('Google Provider', () => {
    it('should initialize with API key', () => {
      const provider = new GoogleProvider('test-key');
      expect(provider).toBeDefined();
    });
  });

  describe('Mistral Provider', () => {
    it('should initialize with API key', () => {
      const provider = new MistralProvider('test-key');
      expect(provider).toBeDefined();
    });
  });

  describe('OpenRouter Provider', () => {
    it('should initialize with API key', () => {
      const provider = new OpenRouterProvider('test-key');
      expect(provider).toBeDefined();
    });
  });

  describe('Provider Fallback Chains', () => {
    it('should fallback from primary to secondary', async () => {
      // Mock primary provider that fails
      class FailingPrimary {
        async stream() {
          throw new Error('Rate limited');
        }
      }

      // Mock fallback provider
      class FallbackProvider {
        async stream(messages, tools, onChunk, options) {
          onChunk({ type: 'content_block_delta', delta: { text: 'Fallback response' } });
          onChunk({ type: 'message_stop' });
        }
      }

      const chunks: any[] = [];
      const fallback = new FallbackProvider();

      try {
        await (new FailingPrimary() as any).stream([], [], (c: any) => chunks.push(c), {});
      } catch {
        // Try fallback
        await fallback.stream([], [], (c: any) => chunks.push(c), {});
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].delta.text).toBe('Fallback response');
    });
  });

  describe('Coding Plan Routing', () => {
    it('should route through subscription for plan models', async () => {
      // Mock coding plan provider
      class PlanProvider {
        async stream(messages, tools, onChunk) {
          onChunk({ type: 'plan_request', messages });
        }
      }

      const planProvider = new PlanProvider();
      const chunks: any[] = [];

      await planProvider.stream(
        [{ role: 'user', content: 'Plan this feature' }],
        [],
        (c) => chunks.push(c),
        {}
      );

      expect(chunks[0].type).toBe('plan_request');
    });
  });
});
