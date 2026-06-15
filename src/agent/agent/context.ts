/**
 * Conversation manager for the agent loop.
 *
 * The coordinator historically appended every tool result verbatim into the
 * `messages` array sent to the model. On long terminal-bench-style tasks (15-30
 * tool turns) a single verbose `bash` (e.g. `apt-get install`) or a large
 * `read` can push the conversation past the model's context window, and later
 * rounds produce truncated/malformed tool-call JSON that silently fails the
 * task. That is the documented failure shape for the cobol task (30 turns, no
 * deliverable produced) and a recurring risk for any task that installs deps.
 *
 * This module owns the running message list and applies two policies before
 * each model call:
 *
 *  1. **Per-result truncation** — every tool result is capped to
 *     `maxResultChars` (head + tail, with an elision marker). A 50k-char
 *     install log becomes ~12k. This alone prevents most blow-ups and preserves
 *     the diagnostically useful head/tail.
 *
 *  2. **Token-aware compaction** — when the estimated total crosses
 *     `compactAtTokens`, the OLDEST tool-bearing turns (assistant tool_calls +
 *     their tool results) are folded into a single `system`-style summary
 *     note: "Prior actions: read X → ok; wrote Y; ran Z → exit 0". The original
 *     system prompt, the original user instruction, and the most recent working
 *     window (configurable via `keepRecentTurns`) are always preserved verbatim.
 *
 * The tokenizer is deliberately crude (~4 chars/token). It doesn't need to be
 * exact — it only needs to trip the compaction threshold before the real
 * provider rejects the request for being too large. Erring slightly early is
 * safe; erring late fails the task.
 *
 * The manager never mutates tool-call ids or rewrites a message the model
 * hasn't seen yet — it only summarizes *consumed* history, which is the same
 * semantic guarantee an explicit "here's what happened so far" recap gives.
 */

/** OpenAI-compatible chat message shape (mirrors the coordinator's internal one). */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ConversationLimits {
  /** Hard cap on each tool-result string before it enters history. */
  maxResultChars: number;
  /** Estimated-token threshold at which compaction triggers. */
  compactAtTokens: number;
  /** Approx tokens-per-char used for the estimate (chars / divisor). */
  charsPerToken: number;
  /** Always keep this many of the most recent messages verbatim. */
  keepRecentTurns: number;
}

export const DEFAULT_LIMITS: ConversationLimits = {
  // 12k chars ≈ 3k tokens — big enough to hold a useful bash/read tail, small
  // enough that even a dozen verbose results don't dominate the window.
  maxResultChars: 12_000,
  // Trip compaction around 96k tokens — comfortably under the 128k windows of
  // the providers we target, leaving headroom for the model's own output.
  compactAtTokens: 96_000,
  charsPerToken: 4,
  // Keep the last ~12 messages (≈ a few tool round-trips) verbatim so the
  // model's current reasoning chain stays intact.
  keepRecentTurns: 12,
};

export class ConversationManager {
  private messages: ContextMessage[] = [];
  private readonly limits: ConversationLimits;
  /** Monotonic counter for compacted-summaries so the model sees progress. */
  private compactionCount = 0;

  constructor(limits: Partial<ConversationLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** All current messages (read-only view for the model call). */
  all(): ContextMessage[] {
    return this.messages;
  }

  /** Number of stored messages. */
  size(): number {
    return this.messages.length;
  }

  /** Append a message verbatim. Used for system/user/assistant turns. */
  push(msg: ContextMessage): void {
    this.messages.push(msg);
  }

  /**
   * Append a tool result, truncating to `maxResultChars` first. Truncation
   * keeps a head and a tail so the model sees both the beginning of the output
   * (usually the signal: file header, command echo) and the end (usually the
   * verdict: exit code, error, test summary).
   */
  pushToolResult(toolCallId: string, content: string): void {
    const truncated = this.truncate(content);
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, content: truncated });
  }

  /** Truncate a single result string per policy. Exposed for tests. */
  truncate(content: string): string {
    const max = this.limits.maxResultChars;
    if (content.length <= max) return content;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    const elided = content.length - max;
    return (
      content.slice(0, head) +
      `\n\n[…${elided} chars elided — output truncated to fit context; re-run the command or read the file directly if you need the full content…]\n\n` +
      content.slice(content.length - tail)
    );
  }

  /** Rough token estimate for the whole conversation. */
  estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      if (typeof m.content === 'string') chars += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) chars += tc.function.arguments.length + tc.function.name.length;
      }
    }
    return Math.ceil(chars / this.limits.charsPerToken);
  }

  /**
   * Compact if the estimated token count exceeds the threshold. Returns true
   * iff a compaction actually happened. Safe to call before every model call.
   *
   * The algorithm:
   *  1. Carve off the prefix to preserve: the system prompt (if any) + the
   *     original user instruction + everything in the recent window.
   *  2. From the middle, fold every assistant-with-tool_calls + its tool
   *     results into one-line summaries.
   *  3. Replace the middle with a single system note carrying those summaries.
   *
   * Non-tool messages in the middle (rare: an assistant text aside, or a user
   * nudge) are kept verbatim but folded into the summary block so order/context
   * isn't lost.
   */
  maybeCompact(): boolean {
    if (this.estimateTokens() <= this.limits.compactAtTokens) return false;
    return this.forceCompact(this.limits.keepRecentTurns);
  }

  /** Force a compaction keeping `keepRecent` of the tail. Returns true iff it did work. */
  forceCompact(keepRecent: number): boolean {
    const n = this.messages.length;
    // We need at least: a system + instruction + recent window + something to
    // compact. With fewer messages there's nothing meaningful to fold.
    if (n <= keepRecent + 2) return false;

    // Preserve the head: leading system prompt(s) + the first user instruction.
    let headEnd = 0;
    while (headEnd < n && this.messages[headEnd].role === 'system') headEnd++;
    // The first non-system message is the original user task — keep it verbatim
    // so the model never loses sight of what it was asked to do.
    if (headEnd < n && this.messages[headEnd].role === 'user') headEnd++;

    const tailStart = Math.max(headEnd, n - keepRecent);
    if (tailStart <= headEnd) return false; // nothing in the middle to compact

    const middle = this.messages.slice(headEnd, tailStart);
    if (middle.length === 0) return false;

    const summary = this.summarize(middle);
    const head = this.messages.slice(0, headEnd);
    const tail = this.messages.slice(tailStart);

    this.messages = [
      ...head,
      { role: 'system', content: summary },
      ...tail,
    ];
    this.compactionCount++;
    return true;
  }

  /** How many compactions have occurred (for tests/observability). */
  compactions(): number {
    return this.compactionCount;
  }

  /**
   * Turn a slice of messages into a compact recap. Tool calls become
   * `tool: result-snippet`; assistant text is kept but trimmed; everything else
   * is dropped to a short note.
   */
  private summarize(messages: ContextMessage[]): string {
    const lines: string[] = [];
    lines.push(`[Compacted ${messages.length} earlier messages into this summary (compaction #${this.compactionCount + 1}). The original task and your most recent actions are preserved verbatim above/below. Do NOT re-do these steps — they already happened.]`);
    lines.push('Prior actions:');

    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          // Find this call's result among subsequent tool messages.
          const result = messages.find(
            (tm) => tm.role === 'tool' && tm.tool_call_id === tc.id,
          );
          const snippet = this.snippet(result?.content);
          lines.push(`  • ${tc.function.name}(${this.briefArgs(tc.function.arguments)}) → ${snippet}`);
        }
      } else if (m.role === 'assistant' && m.content) {
        const t = m.content.trim();
        if (t) lines.push(`  • (assistant) ${this.snippet(t)}`);
      } else if (m.role === 'user' && m.content) {
        // A mid-conversation user nudge (e.g. the progress nudge). Keep it short.
        lines.push(`  • (user) ${this.snippet(m.content)}`);
      }
      // Standalone 'tool' messages without a matching assistant tool_call are
      // covered by the assistant branch above; skip to avoid double-listing.
    }

    return lines.join('\n');
  }

  /** Shorten a result string to a one-line verdict. */
  private snippet(s: string | null | undefined): string {
    if (!s) return '(no output)';
    const oneLine = s.replace(/\n+/g, ' ').trim();
    const max = 160;
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
  }

  /** Reduce tool-call args to a brief, readable hint (path/command/etc). */
  private briefArgs(rawArgs: string): string {
    let parsed: any;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return '';
    }
    if (!parsed || typeof parsed !== 'object') return '';
    const picks = ['path', 'command', 'pattern', 'file_path', 'file'];
    for (const k of picks) {
      if (typeof parsed[k] === 'string' && parsed[k]) {
        const v = parsed[k];
        return `${k}="${v.length > 80 ? v.slice(0, 80) + '…' : v}"`;
      }
    }
    return '';
  }
}
