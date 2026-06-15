/**
 * ConversationManager unit tests.
 *
 * Covers the two policies that prevent context-window exhaustion on long
 * terminal-bench-style tasks:
 *   1. per-result truncation (head + tail + elision marker),
 *   2. token-aware compaction (oldest tool turns folded into a recap, with the
 *      system prompt, original instruction, and recent window preserved).
 *
 * Uses tiny limits so compaction triggers without allocating megabytes.
 */

import { describe, it, expect } from 'bun:test';
import { ConversationManager } from '../../src/agent/agent/context';

describe('ConversationManager', () => {
  describe('result truncation', () => {
    it('leaves short results untouched', () => {
      const cm = new ConversationManager({ maxResultChars: 1000 });
      cm.push({ role: 'system', content: 'sys' });
      cm.push({ role: 'user', content: 'do the thing' });
      cm.pushToolResult('t1', 'short output');
      expect(cm.all()[2].content).toBe('short output');
    });

    it('truncates long results to head + tail with an elision marker', () => {
      const cm = new ConversationManager({ maxResultChars: 100 });
      const big = 'A'.repeat(500);
      cm.pushToolResult('t1', big);
      const content = cm.all()[0].content as string;
      expect(content.length).toBeLessThan(500);
      expect(content).toContain('chars elided');
      expect(content).toContain('output truncated to fit context');
      // Head and tail are both present (A's from start and end of the original).
      expect(content.startsWith('AAAA')).toBe(true);
      expect(content.endsWith('AAAA')).toBe(true);
    });
  });

  describe('token estimation', () => {
    it('estimates tokens as roughly chars/4', () => {
      const cm = new ConversationManager({ charsPerToken: 4 });
      cm.push({ role: 'user', content: 'a'.repeat(400) });
      // ~100 tokens for 400 chars (plus a little for role overhead is fine).
      expect(cm.estimateTokens()).toBeGreaterThan(80);
      expect(cm.estimateTokens()).toBeLessThan(140);
    });
  });

  describe('compaction', () => {
    it('does NOT compact below the threshold', () => {
      const cm = new ConversationManager({ compactAtTokens: 100_000 });
      cm.push({ role: 'system', content: 'sys' });
      cm.push({ role: 'user', content: 'task' });
      cm.pushToolResult('t1', 'result');
      expect(cm.maybeCompact()).toBe(false);
      expect(cm.size()).toBe(3);
    });

    it('compacts when over threshold, preserving system + instruction + recent window', () => {
      // Tiny threshold so a handful of messages trips it.
      const cm = new ConversationManager({
        compactAtTokens: 50, // very low
        keepRecentTurns: 4,
        maxResultChars: 10_000,
      });
      cm.push({ role: 'system', content: 'SYSTEM PROMPT — keep verbatim' });
      cm.push({ role: 'user', content: 'ORIGINAL TASK — keep verbatim' });

      // Several old tool turns that should get summarized away.
      for (let i = 0; i < 6; i++) {
        cm.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `c${i}`,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: `/old/file${i}.py` }) },
          }],
        });
        cm.pushToolResult(`c${i}`, `content of file ${i} — lots of detail here that we do not need anymore`.repeat(20));
      }

      // A recent window that must survive compaction verbatim.
      cm.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'recent',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'pytest' }) },
        }],
      });
      cm.pushToolResult('recent', 'ALL TESTS PASSED');

      const before = cm.size();
      const beforeTokens = cm.estimateTokens();
      const compacted = cm.maybeCompact();
      const afterTokens = cm.estimateTokens();

      expect(compacted).toBe(true);
      expect(cm.compactions()).toBe(1);
      // Tokens dropped substantially.
      expect(afterTokens).toBeLessThan(beforeTokens);

      // System prompt and original task are preserved verbatim.
      const all = cm.all();
      expect(all.some((m) => m.role === 'system' && m.content?.includes('SYSTEM PROMPT — keep verbatim'))).toBe(true);
      expect(all.some((m) => m.role === 'user' && m.content?.includes('ORIGINAL TASK — keep verbatim'))).toBe(true);

      // Recent window survives verbatim (the bash result text is still there).
      expect(all.some((m) => m.content === 'ALL TESTS PASSED')).toBe(true);

      // A compaction summary was inserted.
      expect(all.some((m) => m.role === 'system' && m.content?.includes('Prior actions:'))).toBe(true);

      // The detailed old tool results are gone (no longer than before).
      expect(cm.size()).toBeLessThan(before);
    });

    it('does not compact when there is too little middle to fold', () => {
      const cm = new ConversationManager({
        compactAtTokens: 1, // impossibly low → always wants to compact
        keepRecentTurns: 10, // but more messages than exist → nothing to fold
      });
      cm.push({ role: 'system', content: 's' });
      cm.push({ role: 'user', content: 'u' });
      cm.pushToolResult('t1', 'r');
      expect(cm.maybeCompact()).toBe(false);
    });

    it('the summary records tool names and key args', () => {
      const cm = new ConversationManager({
        compactAtTokens: 50,
        keepRecentTurns: 2,
        maxResultChars: 10_000,
      });
      cm.push({ role: 'system', content: 'sys' });
      cm.push({ role: 'user', content: 'task' });
      cm.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: '/app/solve.py', content: 'big' }) } }],
      });
      cm.pushToolResult('x', 'ok'.repeat(200));
      cm.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'y', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'python /app/solve.py' }) } }],
      });
      cm.pushToolResult('y', 'done'.repeat(200));
      // Push one more assistant turn so both x and y fall into the compacted
      // middle (keepRecentTurns:2 preserves only the final 2 messages).
      cm.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'z', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: '/app/solve.py' }) } }],
      });
      cm.pushToolResult('z', 'final'.repeat(200));

      expect(cm.maybeCompact()).toBe(true);
      const summary = cm.all().find(
        (m) => m.role === 'system' && m.content?.includes('Prior actions:'),
      )?.content as string;
      expect(summary).toContain('write(');
      expect(summary).toContain('/app/solve.py');
      expect(summary).toContain('bash(');
    });
  });
});
