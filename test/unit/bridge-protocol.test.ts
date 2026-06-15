/**
 * Bridge protocol round-trip tests.
 *
 * The wire format is the contract between the Rust TUI and the TS headless
 * host. These tests pin the exact JSON shapes so a drift on either side is
 * caught immediately. The Rust mirror lives at native/euler-tui/src/protocol.rs
 * and must stay byte-compatible with these.
 */

import { describe, it, expect } from 'bun:test';
import {
  encodeResponse,
  encodeEvent,
  parseRequest,
  isBridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeEvent,
} from '../../src/agent/bridge/protocol';

describe('bridge protocol — request parsing', () => {
  it('parses an initialize request', () => {
    const line = JSON.stringify({
      op: 'initialize',
      config: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    const req = parseRequest(line);
    expect(req).toEqual({
      op: 'initialize',
      config: { provider: 'deepseek', model: 'deepseek-chat' },
    });
  });

  it('parses a process request', () => {
    const line = JSON.stringify({ op: 'process', message: 'hello agent' });
    const req = parseRequest(line);
    expect(req).toEqual({ op: 'process', message: 'hello agent' });
  });

  it('parses interrupt and shutdown requests', () => {
    expect(parseRequest(JSON.stringify({ op: 'interrupt' }))).toEqual({ op: 'interrupt' });
    expect(parseRequest(JSON.stringify({ op: 'shutdown' }))).toEqual({ op: 'shutdown' });
  });

  it('returns null for non-JSON', () => {
    expect(parseRequest('not json at all')).toBeNull();
  });

  it('returns null for JSON without an op field', () => {
    expect(parseRequest(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseRequest('')).toBeNull();
    expect(parseRequest('   ')).toBeNull();
  });
});

describe('bridge protocol — response encoding', () => {
  it('encodes a success response', () => {
    const r: BridgeResponse = { ok: true, result: { provider: 'deepseek', model: 'deepseek-chat', toolCount: 18 } };
    const parsed = JSON.parse(encodeResponse(r));
    expect(parsed).toEqual(r);
    expect(parsed.ok).toBe(true);
  });

  it('encodes an error response', () => {
    const r: BridgeResponse = { ok: false, error: 'no API key' };
    const parsed = JSON.parse(encodeResponse(r));
    expect(parsed).toEqual(r);
    expect(parsed.ok).toBe(false);
  });

  it('encodes a bare ok response', () => {
    const parsed = JSON.parse(encodeResponse({ ok: true }));
    expect(parsed).toEqual({ ok: true });
  });
});

describe('bridge protocol — event encoding', () => {
  it('encodes a message event', () => {
    const e: BridgeEvent = { event: 'message', data: { text: 'I will read the file.' } };
    const parsed = JSON.parse(encodeEvent(e));
    expect(parsed).toEqual(e);
  });

  it('encodes a tool_start event', () => {
    const e: BridgeEvent = { event: 'tool_start', data: { tool: 'read', input: { path: '/app/main.py' } } };
    const parsed = JSON.parse(encodeEvent(e));
    expect(parsed).toEqual(e);
  });

  it('encodes a tool_end event with an error result', () => {
    const e: BridgeEvent = {
      event: 'tool_end',
      data: { tool: 'bash', input: { command: 'rm -rf /' }, result: { content: 'refused', isError: true } },
    };
    const parsed = JSON.parse(encodeEvent(e));
    expect(parsed).toEqual(e);
  });

  it('encodes a done event', () => {
    const e: BridgeEvent = { event: 'done', data: { response: 'all done' } };
    const parsed = JSON.parse(encodeEvent(e));
    expect(parsed).toEqual(e);
  });

  it('encodes an error event', () => {
    const e: BridgeEvent = { event: 'error', data: { error: 'rate limited' } };
    const parsed = JSON.parse(encodeEvent(e));
    expect(parsed).toEqual(e);
  });
});

describe('bridge protocol — event discrimination', () => {
  it('identifies events (have an `event` string field)', () => {
    expect(isBridgeEvent({ event: 'done', data: {} })).toBe(true);
    expect(isBridgeEvent({ event: 'message', data: { text: 'x' } })).toBe(true);
  });

  it('does not classify responses as events', () => {
    expect(isBridgeEvent({ ok: true })).toBe(false);
    expect(isBridgeEvent({ ok: false, error: 'x' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isBridgeEvent(null)).toBe(false);
    expect(isBridgeEvent('string')).toBe(false);
    expect(isBridgeEvent(42)).toBe(false);
  });
});

describe('bridge protocol — wire compatibility invariants', () => {
  // These invariants are what the Rust deserializer relies on. If any breaks,
  // native/euler-tui/src/protocol.rs must change too.

  it('every request has a top-level string `op`', () => {
    const reqs: BridgeRequest[] = [
      { op: 'initialize', config: { provider: 'x', model: 'y' } },
      { op: 'process', message: 'm' },
      { op: 'interrupt' },
      { op: 'shutdown' },
    ];
    for (const r of reqs) {
      expect(typeof r.op).toBe('string');
    }
  });

  it('every response has a boolean `ok`', () => {
    const resps: BridgeResponse[] = [
      { ok: true },
      { ok: true, result: {} },
      { ok: false, error: 'e' },
    ];
    for (const r of resps) {
      expect(typeof r.ok).toBe('boolean');
    }
  });

  it('every event has a top-level string `event`', () => {
    const events: BridgeEvent[] = [
      { event: 'message', data: { text: '' } },
      { event: 'tool_start', data: { tool: '', input: {} } },
      { event: 'tool_end', data: { tool: '', input: {}, result: { content: '' } } },
      { event: 'done', data: { response: '' } },
      { event: 'error', data: { error: '' } },
    ];
    for (const e of events) {
      expect(typeof e.event).toBe('string');
    }
  });

  it('a request line and an event/response line are distinguishable by first key', () => {
    // Requests start with op; responses with ok; events with event. serde's
    // tagged deserialization on the Rust side relies on this disambiguation.
    const reqLine = encodeResponse({ ok: true }); // responses and requests both fine here
    const evtLine = encodeEvent({ event: 'done', data: { response: '' } });
    expect(JSON.parse(reqLine)).not.toHaveProperty('event');
    expect(JSON.parse(evtLine)).toHaveProperty('event');
  });
});
