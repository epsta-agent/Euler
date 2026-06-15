/**
 * safeParseArgs repair-ladder unit tests.
 *
 * Weak models emit malformed tool-call arguments constantly. The repair ladder
 * must turn the common cases into valid objects so the tool actually executes,
 * instead of dropping everything to `{_raw}` and failing on "path is required".
 */

import { describe, it, expect } from 'bun:test';
import { safeParseArgs } from '../../src/agent/agent/coordinator';

describe('safeParseArgs', () => {
  it('parses valid JSON unchanged', () => {
    expect(safeParseArgs('{"path": "/a/b.py"}')).toEqual({ path: '/a/b.py' });
  });

  it('returns empty object for empty input', () => {
    expect(safeParseArgs('')).toEqual({});
    expect(safeParseArgs('   ')).toEqual({});
  });

  it('passes through a real object argument', () => {
    expect(safeParseArgs({ path: 'x' } as never)).toEqual({ path: 'x' });
  });

  it('repairs a trailing comma before the closing brace', () => {
    // Common weak-model slip.
    const repaired = safeParseArgs('{"path": "/x.py", "content": "hi",}');
    expect(repaired).toEqual({ path: '/x.py', content: 'hi' });
  });

  it('repairs Python-style single quotes', () => {
    const repaired = safeParseArgs("{'path': '/x.py', 'content': 'hi'}");
    expect(repaired).toEqual({ path: '/x.py', content: 'hi' });
  });

  it('repairs a truncated object by closing braces (write content cut mid-value)', () => {
    // Simulate max_tokens cutting off a large write() mid-content-string.
    // The model emitted valid JSON up to a complete value, then got truncated.
    const truncated = '{"path": "/app/solve.py", "content": "import os\\nprint(1)\\n", "over';
    const repaired = safeParseArgs(truncated) as Record<string, unknown>;
    // The complete, pre-truncation values survive.
    expect(repaired.path).toBe('/app/solve.py');
    expect(repaired.content).toBe('import os\nprint(1)\n');
    // The dangling half-key was dropped (not present as a garbage key).
    expect(Object.keys(repaired).some((k) => k.startsWith('over'))).toBe(false);
  });

  it('falls back to {_raw} only when nothing can be repaired', () => {
    // Truly unstructured prose — no repair should apply.
    const repaired = safeParseArgs('just some words with no json at all');
    expect(repaired).toEqual({ _raw: 'just some words with no json at all' });
  });

  it('round-trips a realistic edit() call', () => {
    const args = JSON.stringify({
      path: '/app/main.py',
      oldText: 'def foo():\n    return 1',
      newText: 'def foo():\n    return 2',
    });
    expect(safeParseArgs(args)).toEqual({
      path: '/app/main.py',
      oldText: 'def foo():\n    return 1',
      newText: 'def foo():\n    return 2',
    });
  });
});
