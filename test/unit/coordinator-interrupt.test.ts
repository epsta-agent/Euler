/**
 * Coordinator interrupt / reset / seedConversation tests.
 *
 * These exercise the new instance-level behavior:
 *   - interrupt() aborts an in-flight chatCompletion (via AbortSignal)
 *   - reset() wipes the conversation
 *   - seedConversation() replays a stored transcript
 *   - multi-turn memory: a second process() sees the first turn's context
 *
 * We stand up a local OpenAI-compatible HTTP server (like coordinator-tool-loop)
 * that lets us script responses + observe the request body.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'http';
import { AgentCoordinator } from '../../src/agent/agent/coordinator';
import { tools as allTools } from '../../src/agent/tool';

function startMockServer(handler: (body: any, res: any) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: any = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        handler(parsed, res);
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

function makeCoordinator(port: number): AgentCoordinator {
  return new AgentCoordinator(
    {} as never,
    allTools,
    {
      provider: 'openai',
      model: 'test',
      apiKey: 'sk-test',
      baseUrl: `http://localhost:${port}/v1`,
    },
  );
}

describe('AgentCoordinator — interrupt, reset, memory', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const s = await startMockServer((_body, res) => {
      // Default: a plain final answer.
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
    server = s.server;
    port = s.port;
  });

  afterAll(async () => {
    await close(server);
  });

  it('interrupt() aborts an in-flight request and resolves to [interrupted]', async () => {
    // A server that never responds — the fetch must be aborted by interrupt().
    const hanging = await startMockServer((_body, _res) => {
      /* never res.end() */
    });
    try {
      const coord = makeCoordinator(hanging.port);
      const events: string[] = [];
      coord.onEvent((e) => events.push(e.type));

      const p = coord.process('hello');
      // Give the fetch a moment to be in flight, then abort.
      await new Promise((r) => setTimeout(r, 100));
      coord.interrupt();
      const result = await p;
      expect(result).toBe('[interrupted]');
      expect(events).toContain('error');
    } finally {
      // Closing a server with a hung response works; the aborted socket closes.
      hanging.server.closeAllConnections?.();
      await close(hanging.server);
    }
  });

  it('reset() clears conversation memory between turns', async () => {
    let seenUserTurns = 0;
    const srv = await startMockServer((body, res) => {
      seenUserTurns = (body.messages || []).filter(
        (m: any) => m.role === 'user',
      ).length;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }));
    });
    try {
      const coord = makeCoordinator(srv.port);
      await coord.process('first message');
      expect(seenUserTurns).toBe(1);

      // Without reset, the second turn sees both messages.
      await coord.process('second message');
      expect(seenUserTurns).toBe(2);

      // After reset, the next turn sees only its own message.
      coord.reset();
      await coord.process('after reset');
      expect(seenUserTurns).toBe(1);
    } finally {
      await close(srv.server);
    }
  });

  it('seedConversation() replays a transcript into the conversation', async () => {
    let userTurns = 0;
    const srv = await startMockServer((body, res) => {
      userTurns = (body.messages || []).filter(
        (m: any) => m.role === 'user',
      ).length;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
    try {
      const coord = makeCoordinator(srv.port);
      // Seed two prior turns.
      coord.seedConversation([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ]);
      // The next process() should see both seeded messages + the new one.
      await coord.process('follow up');
      expect(userTurns).toBe(2); // earlier question + follow up
    } finally {
      await close(srv.server);
    }
  });
});
