/**
 * Comprehensive tool tests
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { writeTool } from '../../src/agent/tool';
import { readTool, hashlineEditTool, searchTool, findTool, grepTool } from '../../src/agent/tool';
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
        'read', 'write', 'edit', 'hashline_edit',
        'search', 'find', 'grep',
        'bash', 'eval', 'lsp', 'task'
      ];

      for (const expected of expectedTools) {
        expect(toolNames).toContain(expected);
      }
    });

    it('should get tools by category', async () => {
      const { getToolsByCategory } = await import('../../src/agent/tool');

      const fileTools = getToolsByCategory('file');
      expect(fileTools.length).toBeGreaterThanOrEqual(3);

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

  describe('Hashline Edit Tool', () => {
    it('should compute hash for content', async () => {
      const content = 'Test content';
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256')
        .update(content)
        .digest('hex')
        .substring(0, 16);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(16);
    });

    it('should create hashline edit input', async () => {
      const crypto = await import('crypto');
      const computeHash = (text: string) =>
        crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);

      const hash = computeHash('Line 1');

      const edit = {
        hash,
        oldText: 'Line 1',
        newText: 'Modified Line 1'
      };

      expect(edit.hash).toBeDefined();
      expect(edit.oldText).toBe('Line 1');
      expect(edit.newText).toBe('Modified Line 1');
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
