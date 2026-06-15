/**
 * Wire protocol for the agent subprocess bridge.
 *
 * The Rust ratatui TUI spawns `bun src/headless.ts` as a child process and
 * communicates over line-delimited JSON on stdio:
 *   - TUI  →  agent : one Request per stdin line
 *   - agent →  TUI  : one Response OR Event per stdout line
 *   - all logging goes to stderr (never stdout — stray output corrupts the
 *     protocol; this is the same discipline native/euler-debug follows)
 *
 * The request shape is tagged on an `"op"` field (serde internally-tagged,
 * matching euler-debug's proven format). Responses use a uniform `{ok,...}`
 * envelope. During a `process` op, the agent emits unsolicited Event lines as
 * AgentEvents fire, ending with a `done` event.
 *
 * These types are mirrored in Rust at native/euler-tui/src/protocol.rs — keep
 * them in sync. Any field added here must be added there and vice versa.
 */

/** A request from the TUI to the agent. Tagged on `op`. */
export type BridgeRequest =
  | { op: 'initialize'; config: InitializeConfig }
  | { op: 'process'; message: string }
  | { op: 'interrupt' }
  | { op: 'shutdown' };

/** Configuration for an initialize request. */
export interface InitializeConfig {
  /** Provider id, e.g. "deepseek", "openai". Must be a key in PROVIDERS. */
  provider: string;
  /** Model id, e.g. "deepseek-chat". */
  model: string;
  /** Explicit API key (overrides the provider's env var). */
  apiKey?: string;
  /** Explicit base URL (overrides the provider's default). */
  baseUrl?: string;
  /** Max tool-use rounds (default 24). */
  maxToolRounds?: number;
  /** Sampling temperature (default 0.7). */
  temperature?: number;
  /** Override the system prompt. */
  systemPrompt?: string;
}

/** Uniform response envelope. `ok: false` carries an error message. */
export interface BridgeResponse {
  ok: boolean;
  /** Present on success. Shape depends on the op. */
  result?: unknown;
  /** Present on failure. */
  error?: string;
}

/**
 * An unsolicited event emitted DURING a `process` op, mirroring the agent's
 * AgentEvent union. The TUI renders these as they arrive (streaming).
 */
export type BridgeEvent =
  | { event: 'message'; data: { text: string } }
  | { event: 'tool_start'; data: { tool: string; input: Record<string, unknown> } }
  | { event: 'tool_end'; data: { tool: string; input: Record<string, unknown>; result: { content: string; isError?: boolean } } }
  | { event: 'done'; data: { response: string } }
  | { event: 'error'; data: { error: string } };

/** Anything the agent writes to stdout is a Response or an Event. */
export type BridgeMessage = BridgeResponse | BridgeEvent;

/** Type guard: a parsed object is an Event (has `event` field) vs Response. */
export function isBridgeEvent(m: unknown): m is BridgeEvent {
  return typeof m === 'object' && m !== null && 'event' in m && typeof (m as any).event === 'string';
}

/** Serialize a Response to a stdout line. */
export function encodeResponse(r: BridgeResponse): string {
  return JSON.stringify(r);
}

/** Serialize an Event to a stdout line. */
export function encodeEvent(e: BridgeEvent): string {
  return JSON.stringify(e);
}

/** Parse a stdin line into a Request, or null if unparseable. */
export function parseRequest(line: string): BridgeRequest | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === 'object' && typeof obj.op === 'string') {
      return obj as BridgeRequest;
    }
  } catch {
    /* fall through */
  }
  return null;
}
