#!/usr/bin/env bun
/**
 * Headless agent subprocess — the bridge between the Rust ratatui TUI and the
 * TypeScript agent.
 *
 * Wire protocol: line-delimited JSON on stdio (see src/agent/bridge/protocol.ts).
 *   stdin  ← Requests  (initialize, process, interrupt, shutdown)
 *   stdout → Responses + Events (one JSON object per line)
 *   stderr → logging only (NEVER stdout — stray output corrupts the protocol)
 *
 * Lifecycle:
 *   1. TUI sends `initialize` → we resolve credentials + construct the
 *      AgentCoordinator (with all 18 tools, context mgmt, etc.) and reply ok.
 *   2. TUI sends `process { message }` → we call coordinator.process(msg);
 *      each AgentEvent streams out as a BridgeEvent line; the final `done`
 *      event carries the response. We also send a Response line so the TUI
 *      can distinguish "op completed" from "event observed".
 *   3. EOF or `shutdown` → cleanup and exit 0.
 *
 * This is the non-interactive counterpart to the old src/cli.tsx TUI entry.
 * The agent logic (coordinator, tools, ConversationManager) is reused verbatim.
 */

import { AgentCoordinator } from './agent/agent/coordinator';
import { tools as allTools } from './agent/tool';
import { resolveProviderCredentials, listConfigurableProviders, getProviderEndpoint } from './agent/model/provider-config';
import { SessionManager } from './sessions/manager';
import {
  type BridgeRequest,
  type BridgeResponse,
  encodeResponse,
  encodeEvent,
  parseRequest,
} from './agent/bridge/protocol';

let coordinator: AgentCoordinator | null = null;
let initialized = false;

/**
 * Persistent session store (SQLite at ~/.euler/sessions.db). One session per
 * initialize; each user message + final assistant answer is appended so the
 * transcript survives across restarts (`--resume` replays it).
 */
let sessions: SessionManager | null = null;
let sessionId: string | null = null;

// A single buffered writer so events and responses interleave cleanly and we
// never emit a partial line. process.stdout is a Bun stream; we write a line
// at a time and flush implicitly (Bun's stdout is unbuffered for writes).
function send(line: string): void {
  // Using the lower-level write to guarantee no transformation.
  const out = process.stdout;
  out.write(line + '\n');
}

function ok(result?: unknown): void {
  const r: BridgeResponse = { ok: true };
  if (result !== undefined) r.result = result;
  send(encodeResponse(r));
}

function fail(error: string): void {
  send(encodeResponse({ ok: false, error }));
}

/** Log to stderr only. */
function log(...args: unknown[]): void {
  process.stderr.write('headless: ' + args.map(String).join(' ') + '\n');
}

/** Handle a single parsed request. */
async function handle(req: BridgeRequest): Promise<void> {
  switch (req.op) {
    case 'initialize': {
      if (initialized && coordinator) {
        fail('already initialized — shutdown first to reinitialize');
        return;
      }
      const cfg = req.config;
      if (!cfg.provider) {
        fail('initialize requires a provider');
        return;
      }
      const providers = listConfigurableProviders();
      if (!providers.includes(cfg.provider)) {
        fail(`unknown provider '${cfg.provider}'. Available: ${providers.join(', ')}`);
        return;
      }
      // Resolve credentials: explicit overrides win, else read the provider's env var.
      const { apiKey, baseUrl } = resolveProviderCredentials({
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
      });
      if (!apiKey) {
        const ep = getProviderEndpoint(cfg.provider);
        fail(`no API key for provider '${cfg.provider}'. Set $${ep?.keyEnv ?? 'API_KEY'} or pass apiKey in the initialize config.`);
        return;
      }
      if (!baseUrl) {
        fail(`no base URL resolved for provider '${cfg.provider}'`);
        return;
      }
      const model = cfg.model || getProviderEndpoint(cfg.provider)?.defaultModel;
      if (!model) {
        fail('initialize requires a model');
        return;
      }

      try {
        coordinator = new AgentCoordinator(
          {} as never, // provider object unused when apiKey+baseUrl are set
          allTools,
          {
            provider: cfg.provider,
            model,
            apiKey,
            baseUrl,
            maxToolRounds: cfg.maxToolRounds,
            temperature: cfg.temperature,
            systemPrompt: cfg.systemPrompt,
          },
        );
        // Open the session store and either resume the most recent session
        // (--resume) or create a fresh one. Resume replays the prior transcript
        // into the coordinator's in-memory conversation so the model remembers.
        try {
          if (!sessions) sessions = new SessionManager();
          if (cfg.resume) {
            const recent = sessions.getMostRecentSession();
            if (recent) {
              sessionId = recent.id;
              sessions.setCurrentSession(sessionId);
              const prior = await sessions.getMessages(sessionId);
              // Replay the stored user/assistant turns into the conversation.
              coordinator.seedConversation(prior);
              log(`resumed session ${sessionId} (${prior.length} messages)`);
            } else {
              sessionId = await sessions.createSession(process.cwd(), model);
              log(`no session to resume; created new session ${sessionId}`);
            }
          } else {
            sessionId = await sessions.createSession(process.cwd(), model);
            log(`created new session ${sessionId}`);
          }
        } catch (sessErr: any) {
          // Persistence is best-effort: a failure here must not block the agent.
          log(`session store unavailable: ${sessErr?.message ?? sessErr}`);
          sessions = null;
          sessionId = null;
        }
        // Bridge every agent event to a stdout Event line.
        coordinator.onEvent((e) => {
          switch (e.type) {
            case 'message': {
              const text = (e.data as { text?: string } | undefined)?.text ?? '';
              send(encodeEvent({ event: 'message', data: { text } }));
              break;
            }
            case 'tool_start': {
              const d = (e.data ?? {}) as { tool: string; input: Record<string, unknown> };
              send(encodeEvent({ event: 'tool_start', data: { tool: d.tool, input: d.input } }));
              break;
            }
            case 'tool_end': {
              const d = (e.data ?? {}) as {
                tool: string;
                input: Record<string, unknown>;
                result: { content: string; isError?: boolean };
              };
              send(encodeEvent({
                event: 'tool_end',
                data: { tool: d.tool, input: d.input, result: { content: d.result.content, isError: d.result.isError } },
              }));
              break;
            }
            case 'done': {
              const response = (e.data as { response?: string } | undefined)?.response ?? '';
              send(encodeEvent({ event: 'done', data: { response } }));
              break;
            }
            case 'error': {
              const error = (e.data as { error?: string } | undefined)?.error ?? 'unknown error';
              send(encodeEvent({ event: 'error', data: { error } }));
              break;
            }
            case 'stream_end':
              // No payload; the TUI infers end-of-stream from `done`. Ignore.
              break;
          }
        });
        initialized = true;
        log(`initialized: provider=${cfg.provider} model=${model} tools=${allTools.length}`);
        ok({ provider: cfg.provider, model, toolCount: allTools.length, sessionId });
      } catch (err: any) {
        fail(`failed to initialize coordinator: ${err?.message ?? err}`);
      }
      return;
    }

    case 'process': {
      if (!coordinator) {
        fail('not initialized — send initialize first');
        return;
      }
      const message = req.message;
      if (typeof message !== 'string' || !message.trim()) {
        fail('process requires a non-empty message');
        return;
      }
      try {
        // Persist the user's message before running (so a crash mid-turn
        // still leaves the question on disk).
        if (sessions && sessionId) {
          try {
            await sessions.appendEntry(sessionId, { type: 'message', role: 'user', content: message });
          } catch { /* best-effort */ }
        }
        // process() returns the final text; events stream out via onEvent.
        const finalText = await coordinator.process(message);
        // Persist the assistant's answer.
        if (sessions && sessionId && finalText) {
          try {
            await sessions.appendEntry(sessionId, { type: 'message', role: 'assistant', content: finalText });
          } catch { /* best-effort */ }
        }
        ok({ response: finalText });
      } catch (err: any) {
        fail(`process failed: ${err?.message ?? err}`);
      }
      return;
    }

    case 'interrupt': {
      // Abort the in-flight model request. The running process() will reject
      // with AbortError, emit an 'error'/'interrupted' event, and return — at
      // which point the normal ok({response}) path fires and the TUI's
      // bridge_busy flag clears. We don't reply to interrupt itself with the
      // final text; the pending process reply does that.
      if (coordinator) {
        coordinator.interrupt();
        log('interrupt: aborted in-flight request');
      }
      ok({ interrupted: true });
      return;
    }

    case 'reset': {
      // /clear: drop the in-memory conversation so the next message starts fresh.
      if (coordinator) {
        coordinator.reset();
        log('reset: conversation cleared');
      }
      ok({ reset: true });
      return;
    }

    case 'shutdown': {
      log('shutdown requested');
      if (sessions) {
        try { sessions.close(); } catch { /* best-effort */ }
      }
      ok();
      process.exit(0);
    }

    default: {
      fail(`unknown op: ${(req as { op: string }).op}`);
    }
  }
}

/** Main read loop: one request per stdin line. */
async function main(): Promise<void> {
  log('headless agent bridge ready (line-delimited JSON on stdio)');

  // Bun: read stdin line-by-line. We buffer to split on newlines ourselves so
  // we never block on a partial line and can handle EOF cleanly.
  //
  // IMPORTANT: a `process` op can run for a long time (model calls, tools). To
  // keep `interrupt` reachable while one is in flight, we do NOT `await` the
  // process handler inline. Instead `process` is fired as a background task and
  // control ops (`interrupt`, `reset`, `shutdown`) are handled immediately when
  // their line arrives — so Esc actually aborts the running request instead of
  // queueing behind it.
  const stdin = process.stdin;
  let buffer = '';
  let pending: Promise<void> | null = null;

  for await (const chunk of stdin) {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const req = parseRequest(line);
      if (!req) {
        fail(`invalid request (not JSON or missing op): ${line.slice(0, 200)}`);
        continue;
      }
      // Control ops run immediately, even mid-turn.
      if (req.op === 'interrupt') {
        await handle(req);
        continue;
      }
      // For everything else, wait for any in-flight process to finish first so
      // we don't interleave two turns. (initialize/reset/shutdown are quick.)
      if (pending) {
        await pending.catch(() => {});
        pending = null;
      }
      if (req.op === 'process') {
        // Fire-and-track: the loop continues reading, so an `interrupt` line
        // arriving during this turn is handled by the branch above.
        pending = handle(req).catch((err) => {
          log('process task error: ' + (err?.message ?? err));
        });
        // Don't await — return control to the reader immediately.
      } else {
        await handle(req);
      }
    }
  }
  // Wait for any in-flight turn before exiting.
  if (pending) await pending.catch(() => {});
  // stdin closed (TUI exited) — clean shutdown.
  log('stdin closed, exiting');
  process.exit(0);
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
