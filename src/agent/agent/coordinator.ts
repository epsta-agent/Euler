/**
 * Agent coordinator.
 *
 * The coordinator owns the agent loop: it sends the conversation to the model
 * with the available tools, executes any tool calls the model returns, feeds
 * the results back, and repeats until the model produces a final text answer
 * (or the turn budget is exhausted). This is what makes the tools actually
 * reachable from the TUI — previously `process()` did a single provider call
 * and never executed tools at all.
 *
 * Tool calling uses the OpenAI-compatible chat-completions schema
 * (tools = [{type:'function', function:{...}}]), which DeepSeek, OpenAI,
 * OpenRouter, and most other providers speak natively. The model id and
 * endpoint come from AgentConfig.
 *
 * If no apiKey/baseUrl is configured the coordinator falls back to the legacy
 * single-shot provider.stream() path so existing callers keep working.
 */

import type { ProviderInterface, Message } from '../model/types';
import type { Tool, ToolResult } from '../tool/types';
import type { AgentConfig, AgentEvent } from './types';
import { ConversationManager, type ContextMessage } from './context';

/** Maximum tool-use round trips before we force a final answer. */
const DEFAULT_MAX_TOOL_ROUNDS = 24;

/** Per-request timeout for a model chat completion. */
const COMPLETION_TIMEOUT_MS = 120_000;

/**
 * Default output cap for a FINAL answer (no tools in play). The model only
 * needs room for a summary here, so this stays modest.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Output cap for a TOOL-CALL turn. Terminal-bench tasks routinely require
 * `write()` calls whose `content` argument is a full source file — 8192 tokens
 * truncates mid-file for anything non-trivial, producing invalid tool-call
 * JSON that silently fails the task. 16384 fits substantial single-file
 * deliverables (COBOL→Python rewrites, multi-hundred-line configs) without the
 * truncation death-spiral.
 */
const TOOL_TURN_MAX_TOKENS = 16384;

/** How many times to retry a model request that fails with a transient error. */
const MAX_RETRIES = 3;

/** True for HTTP statuses that warrant a retry (rate-limit / server faults). */
function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function extractSystemMessage(messages: Message[]): string | undefined {
  return messages.find(m => m.role === 'system')?.content as string | undefined;
}

function filterChatMessages(messages: Message[]): Message[] {
  return messages.filter(m => m.role !== 'system');
}

/** A tool as advertised to an OpenAI-compatible model. */
interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A single chat message in the OpenAI-compatible schema. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface CompletionResponse {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: string;
}

export class AgentCoordinator {
  private provider: ProviderInterface;
  private tools: Tool[];
  private config: AgentConfig;
  private eventHandlers = new Set<(event: AgentEvent) => void>();

  /**
   * Instance-level conversation state. Kept across `process()` calls so the
   * agent remembers prior turns within a session (every other coding agent
   * does this; the previous per-call `new ConversationManager()` meant the TUI
   * had no multi-turn memory at all). Reset via `reset()`.
   */
  private convo: ConversationManager;
  /** True between a process() start and its terminal event (done/error). */
  private running = false;
  /**
   * Abort handle for the in-flight model request, if any. `interrupt()` aborts
   * it so a runaway turn can be cancelled without killing the subprocess — the
   * conversation and the tool-loop state survive, so the next user message
   * continues with full context.
   */
  private currentAbort: AbortController | null = null;

  constructor(provider: ProviderInterface, tools: Tool[], config: AgentConfig) {
    this.provider = provider;
    this.tools = tools;
    this.config = config;
    this.convo = new ConversationManager();
    const sys = this.config.systemPrompt;
    if (sys) this.convo.push({ role: 'system', content: sys });
  }

  onEvent(handler: (event: AgentEvent) => void): void {
    this.eventHandlers.add(handler);
  }

  private emit(event: AgentEvent): void {
    this.eventHandlers.forEach(h => {
      try {
        h(event);
      } catch {
        // A handler error must not break the agent loop.
      }
    });
  }

  /**
   * Abort the in-flight model request for the current turn, if any. Safe to
   * call when idle (no-op). The current `process()` call will reject with an
   * AbortError, which `processWithToolLoop` translates into an `interrupted`
   * event + a short return value. Conversation memory is preserved.
   */
  interrupt(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
  }

  /**
   * Forget the entire conversation and start fresh (used by `/clear`). The
   * system prompt is re-seeded so the model keeps its instructions.
   */
  reset(): void {
    this.convo = new ConversationManager();
    const sys = this.config.systemPrompt;
    if (sys) this.convo.push({ role: 'system', content: sys });
  }

  /**
   * Replay a stored transcript into the conversation (used by `--resume`).
   * Each entry becomes a message in the in-memory conversation so the model
   * has full context for the next user turn. Tool-call structure isn't
   * reconstructed (a resumed turn's prior tool results are folded in as
   * assistant/user text), which is sufficient for continuity.
   */
  seedConversation(messages: Array<{ role: string; content: string }>): void {
    this.reset();
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        this.convo.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
      }
    }
  }

  /**
   * Process a user message and return the assistant's final answer.
   *
   * Runs the tool-use loop when an apiKey/baseURL is configured; otherwise
   * falls back to a single streaming provider call (legacy behavior).
   */
  async process(userMessage: string): Promise<string> {
    if (this.config.apiKey && this.config.baseUrl) {
      return this.processWithToolLoop(userMessage);
    }
    return this.processLegacy(userMessage);
  }

  /** The real tool-use loop. */
  private async processWithToolLoop(userMessage: string): Promise<string> {
    const tools: ModelTool[] = this.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema && typeof t.inputSchema === 'object' && Object.keys(t.inputSchema).length > 0)
          ? t.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      },
    }));

    // The conversation manager is an instance field, so multi-turn memory
    // persists across process() calls. The system prompt was seeded in the
    // constructor / reset(); here we just append the user's new message.
    const convo = this.convo;
    convo.push({ role: 'user', content: userMessage });

    const maxRounds = this.config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const toolsCalled = new Set<string>();

    // An abort controller scoped to this turn. `interrupt()` aborts it.
    const abort = new AbortController();
    this.currentAbort = abort;
    this.running = true;

    try {
      for (let round = 0; round < maxRounds; round++) {
        // Cooperative cancellation: if the user hit Esc, stop now and surface a
        // clean interrupted event instead of continuing the tool loop.
        if (abort.signal.aborted) {
          this.emit({ type: 'error', data: { error: 'interrupted' } });
          return '[interrupted]';
        }

        // Optional progress nudge: if the caller supplied onBeforeModelCall, let
        // it inject a user message (e.g. "you haven't written any file yet").
        if (this.config.onBeforeModelCall) {
          const nudge = this.config.onBeforeModelCall({
            round,
            toolsCalled: Array.from(toolsCalled),
            messageCount: convo.size(),
          });
          if (nudge) convo.push({ role: 'user', content: nudge });
        }

        // Shrink history before the call if it's grown past the compaction
        // threshold. Best-effort: never blocks the loop.
        try {
          convo.maybeCompact();
        } catch {
          // Compaction is an optimization, not a correctness requirement.
        }

        let resp: CompletionResponse;
        try {
          // Tool turns get a larger output budget so a big `write` (e.g. a full
          // Python reimplementation) isn't truncated mid-content, which would
          // produce invalid tool-call JSON that silently fails the task.
          resp = await this.chatCompletion(convo.all(), tools, TOOL_TURN_MAX_TOKENS, abort.signal);
        } catch (err: any) {
          const aborted = err?.name === 'AbortError' || abort.signal.aborted;
          const msg = err?.message ?? String(err);
          if (aborted) {
            this.emit({ type: 'error', data: { error: 'interrupted' } });
            return '[interrupted]';
          }
          this.emit({ type: 'error', data: { error: msg } });
          return `⚠️ Model request failed: ${msg}`;
        }

        // Stream the assistant's text to handlers as message deltas.
        if (resp.content) {
          this.emit({
            type: 'message',
            data: { text: resp.content, delta: true },
          });
        }

        // No tool calls => the model is done; return its text.
        if (resp.toolCalls.length === 0) {
          const finalText = resp.content ?? '';
          this.emit({ type: 'stream_end' });
          this.emit({ type: 'done', data: { response: finalText } });
          return finalText;
        }

        // Record the assistant turn (with its tool calls) in history.
        convo.push({
          role: 'assistant',
          content: resp.content,
          tool_calls: resp.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      });

      // Execute each tool call and append the results (truncated by the manager).
      //
      // Tool calls the model emits in a single turn are independent by
      // construction — the model produced them together, before seeing any of
      // their results, so it cannot be relying on ordering between them. We run
      // them CONCURRENTLY instead of serially. In the container agent every
      // call pays a real `docker exec` spawn cost, and multi-call turns
      // (several reads to map a codebase) are common — parallelizing them is a
      // pure wall-clock win. Order is preserved in history regardless of
      // completion order: Promise.all keeps input-index order, and the append
      // loop below writes results in that order, so the conversation the model
      // sees on the next round is identical to the old sequential behavior.
      // Per-tool error isolation is preserved too (executeTool catches and
      // returns isError results), so one failing call never aborts its siblings.
      const toolResults = await Promise.all(
        resp.toolCalls.map(async (tc) => {
          toolsCalled.add(tc.name);
          this.emit({ type: 'tool_start', data: { tool: tc.name, input: tc.arguments } });
          const result = await this.executeTool(tc.name, tc.arguments);
          this.emit({
            type: 'tool_end',
            data: { tool: tc.name, input: tc.arguments, result },
          });
          const resultText =
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          return { id: tc.id, resultText };
        }),
      );
      for (const { id, resultText } of toolResults) {
        convo.pushToolResult(id, resultText);
      }
    }

    // Turn budget exhausted: ask the model for a final answer with no tools.
    // A final answer is just a summary, so it gets the smaller default budget.
    convo.push({
      role: 'user',
      content:
        'You have reached the tool-call limit. Stop calling tools and give your final answer now based on what you have so far.',
    });
    const final = await this.chatCompletion(convo.all(), [], undefined, abort.signal);
    const finalText = final.content ?? '';
    this.emit({ type: 'stream_end' });
    this.emit({ type: 'done', data: { response: finalText } });
    return finalText;
  } finally {
    this.running = false;
    this.currentAbort = null;
  }
  }

  /** One non-streaming chat completion against the configured endpoint. */
  private async chatCompletion(
    messages: ChatMessage[],
    tools: ModelTool[],
    /** Override max_tokens for this call (e.g. larger budget for tool turns). */
    maxTokensOverride?: number,
    /** External abort signal (from `interrupt()`). Aborting cancels the fetch. */
    externalSignal?: AbortSignal,
  ): Promise<CompletionResponse> {
    const url = (this.config.baseUrl as string).replace(/\/$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: maxTokensOverride ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    // If the caller already aborted before we even started, bail fast.
    if (externalSignal?.aborted) {
      throw new DOMException('interrupted', 'AbortError');
    }

    let data: any;
    // Retry transient failures (429 / 5xx / abort-on-timeout) with
    // exponential backoff. A single rate-limit hiccup must not fail an
    // entire terminal-bench task — runs are long and spans are bursty.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // A user interrupt must NOT be retried — abort immediately.
      if (externalSignal?.aborted) {
        throw new DOMException('interrupted', 'AbortError');
      }
      if (attempt > 0) {
        // 1s, 2s, 4s.
        const backoff = 1000 * Math.pow(2, attempt - 1);
        await sleep(backoff);
      }
      try {
        // A fresh AbortController per attempt: reusing one after abort is a no-op.
        // It's linked to the external signal so a user interrupt aborts the
        // in-flight fetch too, not just future attempts.
        const attemptController = new AbortController();
        const onExternalAbort = () => attemptController.abort();
        if (externalSignal) {
          if (externalSignal.aborted) {
            attemptController.abort();
          } else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
          }
        }
        const attemptTimer = setTimeout(
          () => attemptController.abort(),
          COMPLETION_TIMEOUT_MS,
        );
        let resp: Response;
        try {
          resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: attemptController.signal,
          });
        } finally {
          clearTimeout(attemptTimer);
          if (externalSignal) {
            externalSignal.removeEventListener('abort', onExternalAbort);
          }
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const err = new Error(`model API ${resp.status}: ${text.slice(0, 500)}`);
          if (isTransientStatus(resp.status) && attempt < MAX_RETRIES - 1) {
            lastError = err;
            continue; // retry
          }
          throw err;
        }
        data = await resp.json();
        lastError = null;
        break; // success
      } catch (err: any) {
        // A USER-initiated abort must propagate immediately — never retry it.
        if (externalSignal?.aborted) {
          throw new DOMException('interrupted', 'AbortError');
        }
        // Network error or a timeout-abort: retry, since these are typically
        // transient (connection reset, momentary timeout).
        const aborted = err?.name === 'AbortError';
        if (aborted || isNetworkError(err)) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_RETRIES - 1) continue;
        }
        throw err;
      }
    }
    if (lastError && data === undefined) throw lastError;
    const choice = data.choices?.[0]?.message ?? {};
    const content: string | null =
      typeof choice.content === 'string' ? choice.content : null;
    const toolCalls: CompletionResponse['toolCalls'] = (choice.tool_calls ?? []).map(
      (tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: safeParseArgs(tc.function?.arguments),
      }),
    );
    return {
      content,
      toolCalls,
      finishReason: data.choices?.[0]?.finish_reason ?? 'stop',
    };
  }

  /** Legacy single-shot path (no tool execution). */
  private async processLegacy(userMessage: string): Promise<string> {
    const messages: Message[] = [
      ...(this.config.systemPrompt
        ? [{ role: 'system' as const, content: this.config.systemPrompt }]
        : []),
      { role: 'user' as const, content: userMessage },
    ];

    let response = '';
    let buffer = '';

    const onChunk = (event: AgentEvent) => {
      if (
        event.type === 'message' &&
        event.data &&
        typeof event.data === 'object' &&
        'text' in event.data
      ) {
        buffer += (event.data as { text: string }).text;
      }
      if (event.type === 'stream_end') {
        response = buffer;
      }
    };

    const chatMessages = filterChatMessages(messages);
    await this.provider.stream(
      chatMessages,
      this.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      (chunk: any) => this.handleStreamChunk(onChunk, chunk),
      {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        model: this.config.model,
      },
    );

    this.emit({ type: 'done', data: { response } });
    return response;
  }

  private handleStreamChunk(
    onChunk: (event: AgentEvent) => void,
    chunk: any,
  ): void {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta?.type === 'text_delta'
    ) {
      onChunk({ type: 'message', data: { text: chunk.delta.text, delta: true } });
    } else if (chunk.type === 'message_stop') {
      onChunk({ type: 'stream_end' });
    }
  }

  async executeTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      return { content: `Tool not found: ${toolName}`, isError: true };
    }
    try {
      const result = await tool.execute(input);
      return result;
    } catch (err: any) {
      return {
        content: `Tool '${toolName}' threw: ${err?.message ?? err}`,
        isError: true,
      };
    }
  }

  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Parse a model-emitted tool-call arguments string into an object.
 *
 * Weak models routinely emit arguments that aren't valid JSON:
 *  - truncated mid-string when `max_tokens` cuts off a large `write` payload,
 *  - single-quoted (Python-style) instead of double-quoted,
 *  - trailing comma before the closing brace,
 *  - raw unquoted prose.
 *
 * The previous behavior dropped these to `{ _raw: raw }`, which then made
 * every tool fail its first validation check ("'path' is required") — wasting a
 * full round and derailing the task. Instead we try a sequence of cheap repairs
 * before giving up, so a near-valid call actually executes. Only when all
 * repairs fail do we surface the raw text (under `_raw`) so the tool's own
 * validation can produce its actionable error.
 *
 * Exported for direct unit testing of the repair ladder.
 */
export function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // 1. Happy path.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to repairs
  }

  // 2. Backslash-truncation repair: the model produced valid JSON up to the
  //    token cap. Find the last complete key/value and close the object.
  const repaired = repairTruncatedObject(trimmed);
  if (repaired !== null) {
    try {
      return JSON.parse(repaired);
    } catch {
      // try more repairs
    }
  }

  // 3. Trailing-comma repair: `{ "path": "x", }` is invalid JSON but trivially fixable.
  try {
    return JSON.parse(trimmed.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    // fall through
  }

  // 4. Single→double quote repair for simple flat objects (Python-style output).
  try {
    const doubled = trimmed.replace(/'/g, '"');
    return JSON.parse(doubled);
  } catch {
    // give up gracefully
  }

  // Last resort: keep the raw text so the tool's validator can explain exactly
  // what's wrong, rather than the coordinator silently dropping all args.
  return { _raw: raw };
}

/**
 * Attempt to repair a JSON object string that was cut off mid-write by the
 * output token cap. Strategy: scan left from the end, tracking string/escape
 * state, and cut at the last position where the object is structurally
 * closable (inside a value → drop to the end of the previous complete value,
 * then close any open braces/brackets).
 *
 * Returns a repaired string if a closable prefix was found, else null.
 */
function repairTruncatedObject(s: string): string | null {
  // Must look like an object/JSON value to bother.
  if (!s.startsWith('{') && !s.startsWith('[')) return null;

  // Walk the string tracking whether we're inside a string literal; find the
  // last index that ends a complete top-level value we can close from.
  let inString = false;
  let escape = false;
  let lastComplete = -1;
  let depth = 0;
  let prevNonSpace: string | null = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      continue;
    }
    if (ch === ',') {
      // A comma marks the end of a complete value (the char before it, sans
      // whitespace, was a value terminator). Record this position as a safe
      // truncation point.
      lastComplete = i;
    }
    if (!/\s/.test(ch)) prevNonSpace = ch;
  }

  // If the string already parses, nothing to do (caller handles that). Here we
  // only act when we were cut off: the last non-space char is not a closing
  // bracket matching the opener.
  const opener = s[0];
  const closer = opener === '{' ? '}' : ']';
  if (prevNonSpace === closer) return null; // looks complete already

  // Cut at the last safe comma (end of a complete value), trim trailing
  // punctuation/whitespace, and close all open containers.
  let cut = lastComplete >= 0 ? s.slice(0, lastComplete) : s;
  // Trim trailing commas, whitespace, and incomplete key tokens (e.g. `"pa`).
  cut = cut.replace(/[\s,]+$/, '');
  // If it ends mid-key (e.g. `..., "path`), drop the dangling fragment.
  cut = cut.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');

  // Recount open vs closed braces/brackets in the trimmed string and append the
  // missing closers. Cheap scan ignoring string contents is good enough: we
  // only append closers, we never delete structure.
  let opens = 0;
  for (const ch of cut) {
    if (ch === '{' || ch === '[') opens++;
    else if (ch === '}' || ch === ']') opens--;
  }
  if (opens < 0) return null; // malformed in a way we can't fix
  let repaired = cut;
  for (let i = 0; i < opens; i++) repaired += closer;
  return repaired;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for fetch failures caused by the network (not HTTP status). */
function isNetworkError(err: any): boolean {
  if (!err) return false;
  const name = err.name ?? '';
  const msg = String(err.message ?? err);
  // TypeError is what fetch() throws on DNS/connection failures; ECONNRESET
  // and friends surface in the message. We deliberately do NOT retry on
  // programmer errors (bad URL, invalid body) — those throw synchronously
  // before/around fetch and aren't transient.
  return (
    name === 'TypeError' ||
    name === 'AbortError' ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(msg)
  );
}
