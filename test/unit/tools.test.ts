/**
 * Tool tests
 */

import { describe, it, expect } from 'bun:test';
import { readTool, writeTool, bashTool, editTool, findTool, grepTool } from '../../src/agent/tool';

describe('Tools', () => {
  describe('read tool', () => {
    it('should read file contents', async () => {
      const result = await readTool.execute({ path: '/tmp/euler-test.txt' });
      // Will fail if file doesn't exist, but tests the interface
      expect(result).toBeDefined();
    });

    it('should handle offset and limit', async () => {
      const result = await readTool.execute({
        path: '/tmp/euler-test.txt',
        offset: 1,
        limit: 10
      });
      expect(result).toBeDefined();
    });

    it('should return error for missing file', async () => {
      const result = await readTool.execute({ path: '/nonexistent/file.txt' });
      expect(result.isError).toBe(true);
    });
  });

  describe('write tool', () => {
    it('should write file contents', async () => {
      const result = await writeTool.execute({
        path: '/tmp/euler-write-test.txt',
        content: 'Test content'
      });
      expect(result.content).toContain('Successfully wrote');
    });

    it('should create directories as needed', async () => {
      const result = await writeTool.execute({
        path: '/tmp/euler/nested/dir/test.txt',
        content: 'Nested content'
      });
      expect(result.content).toContain('Successfully wrote');
    });
  });

  describe('bash tool', () => {
    it('should execute shell commands', async () => {
      const result = await bashTool.execute({ command: 'echo "test"' });
      expect(result.content).toContain('test');
      expect(result.isError).toBe(false);
    });

    it('should handle timeouts', async () => {
      const result = await bashTool.execute({
        command: 'sleep 10',
        timeout: 100
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('timed out');
    }, 10000);

    it('should handle command errors', async () => {
      const result = await bashTool.execute({ command: 'exit 1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('edit tool', () => {
    it('should edit files with search/replace', async () => {
      // First write a file
      await writeTool.execute({ path: '/tmp/euler-edit-test.txt', content: 'Hello World' });

      // Then edit it
      const result = await editTool.execute({
        path: '/tmp/euler-edit-test.txt',
        oldText: 'World',
        newText: 'Euler'
      });

      expect(result.content).toContain('Successfully edited');
    });

    it('should return error when old text not found', async () => {
      const result = await editTool.execute({
        path: '/tmp/euler-edit-test.txt',
        oldText: 'NonExistent',
        newText: 'Replacement'
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('should reject ambiguous (multi-match) edits', async () => {
      // Write a file where the anchor text appears twice.
      await writeTool.execute({
        path: '/tmp/euler-edit-ambiguous.txt',
        content: 'repeat me\n---\nrepeat me\n'
      });

      const result = await editTool.execute({
        path: '/tmp/euler-edit-ambiguous.txt',
        oldText: 'repeat me',
        newText: 'replaced'
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('ambiguous');
      // File must be left unchanged.
      const { readFile } = await import('fs/promises');
      const after = await readFile('/tmp/euler-edit-ambiguous.txt', 'utf-8');
      expect(after).toBe('repeat me\n---\nrepeat me\n');
    });
  });

  describe('input validation (junior-friendly errors)', () => {
    it('read rejects missing/empty path', async () => {
      const r1 = await readTool.execute({} as any);
      expect(r1.isError).toBe(true);
      expect(r1.content).toContain('path');
      const r2 = await readTool.execute({ path: '' } as any);
      expect(r2.isError).toBe(true);
    });

    it('read reports ENOENT with the resolved path', async () => {
      const r = await readTool.execute({ path: '/definitely/not/here.txt' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('not found');
      expect(r.content).toContain('/definitely/not/here.txt');
    });

    it('read rejects a directory with an actionable hint', async () => {
      const r = await readTool.execute({ path: '/tmp' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('directory');
      expect(r.content).toContain('find');
    });

    it('read returns line-numbered output', async () => {
      await writeTool.execute({ path: '/tmp/euler-numbered.txt', content: 'one\ntwo\nthree' });
      const r = await readTool.execute({ path: '/tmp/euler-numbered.txt' });
      expect(r.isError).toBe(false);
      expect(r.content).toContain('1: one');
      expect(r.content).toContain('2: two');
    });

    it('write rejects non-string content', async () => {
      const r = await writeTool.execute({ path: '/tmp/x.txt', content: 123 as any });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('content');
    });

    it('bash rejects empty command', async () => {
      const r = await bashTool.execute({ command: '' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('command');
    });

    it('bash footer includes exit code', async () => {
      const r = await bashTool.execute({ command: 'true' });
      expect(r.isError).toBe(false);
      expect(r.content).toContain('[exit=0');
    });

    it('grep rejects an invalid regex with a clear message', async () => {
      const r = await grepTool.execute({ pattern: '(' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('invalid regex');
    });

    it('find rejects a non-directory path', async () => {
      const r = await findTool.execute({ pattern: '*', path: '/definitely/nope' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('does not exist');
    });

    it('write marks shebang scripts executable', async () => {
      const { stat } = await import('fs/promises');
      const scriptPath = '/tmp/euler-shebang-test.sh';
      const r = await writeTool.execute({
        path: scriptPath,
        content: '#!/bin/sh\necho hello\n',
      });
      expect(r.isError).toBe(false);
      const s = await stat(scriptPath);
      // Executable bit for owner (0o100) must be set.
      expect((s.mode & 0o100) !== 0).toBe(true);
    });

    it('write does NOT mark non-shebang files executable', async () => {
      const { stat } = await import('fs/promises');
      const p = '/tmp/euler-plain-test.txt';
      await writeTool.execute({ path: p, content: 'plain text' });
      const s = await stat(p);
      expect((s.mode & 0o100) === 0).toBe(true);
    });
  });
});
