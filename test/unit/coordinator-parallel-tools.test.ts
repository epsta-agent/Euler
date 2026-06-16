/**
 * Parallel tool execution regression test.
 *
 * When the model returns multiple tool_calls in one turn, the coordinator runs
 * them CONCURRENTLY (Promise.all) and appends their results in input order.
 * This test pins three properties of that behavior:
 *
 *   1. Every tool call in the batch executes (none is skipped).
 *   2. Tool results are appended to history in the SAME ORDER the model emitted
 *      them, regardless of which finished first — so the model sees a stable,
 *      deterministic transcript on the next round.
 *   3. The calls actually overlap in time (the whole point of the change): two
 *      tools that each sleep 150ms complete in well under 2×150ms when run
 *      concurrently. A sequential implementation would take ≥300ms.
 *
 * Properties 1-2 are correctness invariants; property 3 is the performance win.
 */

import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'http';
import { AgentCoordinator } from '../../src/agent/agent/coordinator';
import type { Tool } from '../../src/agent/tool/types';

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/**
 * A fake tool that resolves after a fixed delay. The delay lets us assert
 * overlap between two concurrently-run tools.
 */
function makeSleepTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `sleep ${delayMs}ms`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { content: `${name}-done` };
    },
  };
}

describe('AgentCoordinator — parallel tool execution', () => {
  it('runs the tools the model returns in one turn concurrently and appends results in order', async () => {
    // Script the model: first response emits two tool_calls; subsequent
    // responses return a final text answer. We capture the tool messages the
    // coordinator writes back into history on the second request.
    let lastToolMessages: any[] = [];
    let call = 0;

    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        call++;
        if (call === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'a', type: 'function', function: { name: 'slow_a', arguments: '{}' } },
                  { id: 'b', type: 'function', function: { name: 'slow_b', arguments: '{}' } },
                ],
              },
            }],
          }));
        } else {
          let parsed: any = {};
          try { parsed = JSON.parse(body); } catch { /* ignore */ }
          lastToolMessages = (parsed.messages || []).filter((m: any) => m.role === 'tool');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const tools: Tool[] = [
        makeSleepTool('slow_a', 150),
        makeSleepTool('slow_b', 150),
      ];

      const coord = new AgentCoordinator(
        {} as never,
        tools,
        {
          provider: 'test',
          model: 'test',
          apiKey: 'sk-test',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          maxToolRounds: 3,
        },
      );

      const events: any[] = [];
      coord.onEvent((e) => events.push(e));
      const t0 = Date.now();
      await coord.process('run both');
      const elapsed = Date.now() - t0;

      // (1) Both tools ran.
      const starts = events.filter((e) => e.type === 'tool_start');
      expect(starts.map((e) => e.data.tool)).toEqual(['slow_a', 'slow_b']);
      expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2);

      // (2) Results appended in the model's emit order (a before b), regardless
      //     of completion order.
      expect(lastToolMessages.map((m: any) => m.tool_call_id)).toEqual(['a', 'b']);

      // (3) Concurrency: two 150ms sleeps that overlap finish in ~150ms, not
      //     ~300ms. Allow generous headroom over the single-sleep floor and a
      //     hard ceiling well under the serial 300ms+ floor.
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(290); // serial would be ≥300ms
    } finally {
      await close(server);
    }
  }, 15000);
});

