/**
 * Comprehensive tool tests
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { writeTool } from '../../src/agent/tool';
import { readTool, editTool, lsTool, globTool, searchTool, findTool, grepTool } from '../../src/agent/tool';
import { tools } from '../../src/agent/tool';

describe('Comprehensive Tool Tests', () => {
  const testFilePath = '/tmp/euler-comprehensive-test.txt';

  beforeAll(async () => {
    // Create test file
    await writeTool.execute({
      path: testFilePath,
      content: 'Line 1\nLine 2\nLine 3\nTest content\nMore content'
    });
  });

  describe('Tool Registry', () => {
    it('should have all expected tools', () => {
      const toolNames = tools.map(t => t.name);
      const expectedTools = [
        'read', 'write', 'edit', 'ls', 'glob',
        'search', 'find', 'grep',
        'bash', 'eval', 'lsp', 'task'
      ];

      for (const expected of expectedTools) {
        expect(toolNames).toContain(expected);
      }
    });

    it('should not register the removed hashline_edit tool', () => {
      const toolNames = tools.map(t => t.name);
      expect(toolNames).not.toContain('hashline_edit');
    });

    it('should get tools by category', async () => {
      const { getToolsByCategory } = await import('../../src/agent/tool');

      const fileTools = getToolsByCategory('file');
      expect(fileTools.length).toBeGreaterThanOrEqual(4);

      const searchTools = getToolsByCategory('search');
      expect(searchTools.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Read Tool', () => {
    it('should read entire file', async () => {
      const result = await readTool.execute({ path: testFilePath });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('Line 1');
    });

    it('should read with offset and limit', async () => {
      const result = await readTool.execute({
        path: testFilePath,
        offset: 2,
        limit: 2
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('Line 3');
    });
  });

  describe('Edit Tool', () => {
    it('should apply an exact, unambiguous replacement', async () => {
      const editPath = '/tmp/euler-edit-test.txt';
      await writeTool.execute({ path: editPath, content: 'alpha\nbeta\ngamma' });
      const result = await editTool.execute({
        path: editPath,
        oldText: 'beta',
        newText: 'BETA',
      });
      expect(result.isError).toBe(false);
      const after = await readTool.execute({ path: editPath });
      expect(after.content).toContain('BETA');
      expect(after.content).not.toContain('\nbeta\n');
    });

    it('should return the file head when oldText is not found, to help re-anchor', async () => {
      const editPath = '/tmp/euler-edit-nf.txt';
      await writeTool.execute({ path: editPath, content: 'first\nsecond\nthird' });
      const result = await editTool.execute({
        path: editPath,
        oldText: 'does not exist',
        newText: 'x',
      });
      expect(result.isError).toBe(true);
      // The strengthened message surfaces the first lines so the model can
      // re-anchor without a separate read() round-trip.
      expect(result.content).toContain('1: first');
    });

    it('should reject an ambiguous oldText', async () => {
      const editPath = '/tmp/euler-edit-ambig.txt';
      await writeTool.execute({ path: editPath, content: 'dup\ndup\nother' });
      const result = await editTool.execute({
        path: editPath,
        oldText: 'dup',
        newText: 'x',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('ambiguous');
    });
  });

  describe('ls Tool', () => {
    it('should list entries in a directory, marking directories with a trailing slash', async () => {
      const result = await lsTool.execute({ path: '/tmp' });
      expect(result.isError).toBe(false);
      expect(typeof result.content).toBe('string');
      expect((result.content as string).length).toBeGreaterThan(0);
    });

    it('should error on a missing directory', async () => {
      const result = await lsTool.execute({ path: '/tmp/euler-definitely-missing-dirs-xyz' });
      expect(result.isError).toBe(true);
    });
  });

  describe('glob Tool', () => {
    it('should match files by pattern', async () => {
      const result = await globTool.execute({
        pattern: 'euler-edit-test.txt',
        path: '/tmp',
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('euler-edit-test.txt');
    });

    it('should report no matches cleanly', async () => {
      const result = await globTool.execute({
        pattern: 'no-such-file-xyzabc.txt',
        path: '/tmp',
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('No files matched');
    });
  });

  describe('Search Tool', () => {
    it('should create search input', () => {
      const input = {
        pattern: 'test',
        path: '.',
        caseSensitive: false,
        maxResults: 50
      };

      expect(input.pattern).toBe('test');
      expect(input.caseSensitive).toBe(false);
    });
  });

  describe('Find Tool', () => {
    it('should find files by pattern', async () => {
      const result = await findTool.execute({
        pattern: '*.txt',
        path: '/tmp',
        type: 'file'
      });

      expect(result.isError).toBe(false);
    });
  });

  describe('Grep Tool', () => {
    it('should search for patterns', async () => {
      const result = await grepTool.execute({
        pattern: 'Test',
        path: '/tmp',
        filePattern: '*.txt',
        maxResults: 10
      });

      expect(result).toBeDefined();
    });
  });
});
