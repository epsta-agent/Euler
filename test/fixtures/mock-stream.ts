/**
 * Mock streaming utilities for testing
 */

export interface MockStreamChunk {
  type: string;
  delta?: { text: string };
  index?: number;
}

export function createMockStreamResponse(text: string): MockStreamChunk[] {
  const chunks: MockStreamChunk[] = [];

    chunks.push({ type: 'content_block_delta', delta: { text } });
    chunks.push({ type: 'message_stop' });

  return chunks;
}

export function createMockStreamWithToolCalls(tools: Array<{ name: string; input: any }>): MockStreamChunk[] {
  const chunks: MockStreamChunk[] = [];

  for (const tool of tools) {
    chunks.push({ type: 'content_block_delta', delta: { text: `Calling ${tool.name}` } });
  }

  chunks.push({ type: 'message_stop' });
  return chunks;
}

export class MockStreamController {
  private chunks: MockStreamChunk[] = [];
  private currentIndex = 0;

  addChunk(chunk: MockStreamChunk): void {
    this.chunks.push(chunk);
  }

  async *stream(): AsyncGenerator<MockStreamChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  getChunks(): MockStreamChunk[] {
    return [...this.chunks];
  }

  reset(): void {
    this.chunks = [];
    this.currentIndex = 0;
  }
}
