/**
 * AgentCoordinator tool-use loop test.
 *
 * Proves the coordinator executes tool calls returned by the model and feeds
 * results back. We stand up a tiny local HTTP server that speaks the
 * OpenAI-compatible chat-completions schema and scripts two responses:
 *   1. an assistant message with one tool_call (read),
 *   2. a final assistant text answer that echoes the tool result.
 *
 * If the loop works, `process()` returns the final text AND the tool actually
 * ran (we assert the file was read). This is the regression test for "the agent
 * never calls tools".
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'http';
import { writeFile } from 'fs/promises';
import { AgentCoordinator } from '../../src/agent/agent/coordinator';
import { readTool } from '../../src/agent/tool';

let server: Server;
let baseUrl: string;
let callCount = 0;

beforeAll(async () => {
  await writeFile('/tmp/euler-coord-loop-test.txt', 'hello-from-tool');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // First call: model returns a tool_call to read the file.
      // Second call: model returns a final text answer summarizing the result.
      if (callCount === 1) {
        res.end(JSON.stringify({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ path: '/tmp/euler-coord-loop-test.txt' }),
                },
              }],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'TOOL_SAW:hello-from-tool' },
          }],
        }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  }
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('AgentCoordinator tool-use loop', () => {
  it('executes a tool call returned by the model and feeds the result back', async () => {
    const coordinator = new AgentCoordinator(
      // The provider is only used for the legacy fallback path; the loop uses
      // apiKey + baseUrl directly, so a stub is fine here.
      {} as any,
      [readTool],
      {
        provider: 'test',
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl,
        maxToolRounds: 5,
      },
    );

    const events: any[] = [];
    coordinator.onEvent((e) => events.push(e));

    const answer = await coordinator.process('Read the file and tell me what it says.');

    // The final answer must reflect that the tool actually ran with the RIGHT
    // input (this catches the tc.input-vs-tc.arguments bug: if the tool
    // received undefined input, the mock's canned answer would still match but
    // the tool result fed back would be an error string, not the file content).
    expect(answer).toContain('TOOL_SAW:hello-from-tool');

    // The loop must have emitted tool_start + tool_end for 'read'.
    const started = events.some(
      (e) => e.type === 'tool_start' && (e.data as any)?.tool === 'read',
    );
    const ended = events.some((e) => e.type === 'tool_end');
    expect(started).toBe(true);
    expect(ended).toBe(true);

    // The tool result fed back must contain the actual file content, proving
    // the tool executed with correct arguments (not an error from bad input).
    const toolEnd = events.find((e) => e.type === 'tool_end') as any;
    const toolResultContent = toolEnd?.data?.result?.content ?? '';
    expect(toolResultContent).toContain('hello-from-tool');

    // Exactly two model calls: tool_call, then final.
    expect(callCount).toBe(2);
  }, 15000);
});
