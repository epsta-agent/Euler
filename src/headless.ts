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
import {
  type BridgeRequest,
  type BridgeResponse,
  encodeResponse,
  encodeEvent,
  parseRequest,
} from './agent/bridge/protocol';

let coordinator: AgentCoordinator | null = null;
let initialized = false;

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
        ok({ provider: cfg.provider, model, toolCount: allTools.length });
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
        // process() returns the final text; events stream out via onEvent.
        const finalText = await coordinator.process(message);
        ok({ response: finalText });
      } catch (err: any) {
        fail(`process failed: ${err?.message ?? err}`);
      }
      return;
    }

    case 'interrupt': {
      // Best-effort: there's no clean cooperative cancel on the coordinator today.
      // We acknowledge; the TUI may choose to restart the subprocess for a hard cancel.
      log('interrupt received (cooperative cancel not yet supported — restart subprocess for hard cancel)');
      ok({ interrupted: true });
      return;
    }

    case 'shutdown': {
      log('shutdown requested');
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
  const stdin = process.stdin;
  let buffer = '';

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
      await handle(req);
    }
  }
  // stdin closed (TUI exited) — clean shutdown.
  log('stdin closed, exiting');
  process.exit(0);
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
