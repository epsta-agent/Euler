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

/** Maximum tool-use round trips before we force a final answer. */
const DEFAULT_MAX_TOOL_ROUNDS = 24;

/** Per-request timeout for a model chat completion. */
const COMPLETION_TIMEOUT_MS = 120_000;

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

  constructor(provider: ProviderInterface, tools: Tool[], config: AgentConfig) {
    this.provider = provider;
    this.tools = tools;
    this.config = config;
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

    const messages: ChatMessage[] = [];
    const sys = this.config.systemPrompt;
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: userMessage });

    const maxRounds = this.config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const toolsCalled = new Set<string>();

    for (let round = 0; round < maxRounds; round++) {
      // Optional progress nudge: if the caller supplied onBeforeModelCall, let
      // it inject a user message (e.g. "you haven't written any file yet").
      if (this.config.onBeforeModelCall) {
        const nudge = this.config.onBeforeModelCall({
          round,
          toolsCalled: Array.from(toolsCalled),
          messageCount: messages.length,
        });
        if (nudge) messages.push({ role: 'user', content: nudge });
      }

      let resp: CompletionResponse;
      try {
        resp = await this.chatCompletion(messages, tools);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
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
      messages.push({
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

      // Execute each tool call and append the results.
      for (const tc of resp.toolCalls) {
        toolsCalled.add(tc.name);
        this.emit({ type: 'tool_start', data: { tool: tc.name, input: tc.arguments } });
        const result = await this.executeTool(tc.name, tc.arguments);
        this.emit({
          type: 'tool_end',
          data: { tool: tc.name, input: tc.arguments, result },
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        });
      }
    }

    // Turn budget exhausted: ask the model for a final answer with no tools.
    messages.push({
      role: 'user',
      content:
        'You have reached the tool-call limit. Stop calling tools and give your final answer now based on what you have so far.',
    });
    const final = await this.chatCompletion(messages, []);
    const finalText = final.content ?? '';
    this.emit({ type: 'stream_end' });
    this.emit({ type: 'done', data: { response: finalText } });
    return finalText;
  }

  /** One non-streaming chat completion against the configured endpoint. */
  private async chatCompletion(
    messages: ChatMessage[],
    tools: ModelTool[],
  ): Promise<CompletionResponse> {
    const url = (this.config.baseUrl as string).replace(/\/$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 4096,
      stream: false,
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`model API ${resp.status}: ${text.slice(0, 500)}`);
      }
      const data: any = await resp.json();
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
    } finally {
      clearTimeout(timer);
    }
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

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}
