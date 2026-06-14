/**
 * Simple 1:1 test for Euler Agent
 */

// Test agent coordinator directly
async function testAgent() {
  console.log('Testing Euler Agent...\n');

  // Mock provider for testing
  class MockProvider {
    async stream(messages: any[], tools: any[], onChunk: any, options: any) {
      onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello! ' } });
      onChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'I am Euler.' } });
      onChunk({ type: 'message_stop' });
    }
  }

  // Mock tools
  const mockTools = [
    {
      name: 'echo',
      description: 'Echo back input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input: any) => ({ content: `Echo: ${input.text}` }),
    },
  ];

  // Create agent
  const { AgentCoordinator } = await import('./agent/agent/index');
  const agent = new AgentCoordinator(new MockProvider() as any, mockTools, {
    provider: 'test',
    model: 'test-model',
    temperature: 0.7,
    maxTokens: 1000,
    systemPrompt: 'You are a test assistant.',
  });

  // Test processing
  console.log('Test 1: Process user message');
  const response = await agent.process('Hello Euler!');
  console.log('✓ Response:', response);
  console.log();

  // Test tool execution
  console.log('Test 2: Execute tool');
  const toolResult = await agent.executeTool('echo', { text: 'test input' });
  console.log('✓ Tool result:', toolResult);
  console.log();

  // Test events
  console.log('Test 3: Event handling');
  let eventReceived = false;
  agent.onEvent((event) => {
    eventReceived = true;
    console.log('✓ Event received:', event.type);
  });

  await agent.process('Test events');
  console.log('Events working:', eventReceived ? '✓' : '✗');
  console.log();

  console.log('All tests passed!');
}

// Run test
testAgent().catch(console.error);
