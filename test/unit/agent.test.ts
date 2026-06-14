/**
 * Agent unit tests
 */

import { describe, it, expect } from 'bun:test';
import { AgentCoordinator } from '../../src/agent/agent/coordinator';

describe('Agent Coordinator', () => {
  it('should process user messages', async () => {
    const mockProvider = {
      async stream(messages, tools, onChunk, options) {
        onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Response' } });
        onChunk({ type: 'message_stop' });
      }
    };

    const mockTools = [{
      name: 'test',
      description: 'Test tool',
      inputSchema: { type: 'object' },
      execute: async () => ({ content: 'Test result' })
    }];

    const agent = new AgentCoordinator(mockProvider as any, mockTools, {
      provider: 'test',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 1000,
    });

    const response = await agent.process('Hello');
    expect(response).toBe('Response');
  });

  it('should execute tools', async () => {
    const mockProvider = { async stream() {} };

    const mockTools = [{
      name: 'echo',
      description: 'Echo tool',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input: any) => ({ content: `Echo: ${input.text}` })
    }];

    const agent = new AgentCoordinator(mockProvider as any, mockTools, {
      provider: 'test',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 1000,
    });

    const result = await agent.executeTool('echo', { text: 'test' });
    expect(result.content).toBe('Echo: test');
  });

  it('should emit events', async () => {
    let eventReceived = false;
    const mockProvider = {
      async stream(messages, tools, onChunk, options) {
        onChunk({ type: 'test_event' });
      }
    };

    const agent = new AgentCoordinator(mockProvider as any, [], {
      provider: 'test',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 1000,
    });

    agent.onEvent(() => { eventReceived = true; });
    await agent.process('test');

    expect(eventReceived).toBe(true);
  });
});
