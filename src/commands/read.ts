/**
 * Read command - Following oh-my-pi CLI architecture
 * File reader utility
 */

export default {
  name: 'read',
  description: 'File reader utility',
  handler: async (args: string[]) => {
    const path = args?.[0];

    if (!path) {
      return `Usage: euler read <file> [options]

Read and display file contents.

Options:
  --lines N       Show only first N lines
  --from N        Start from line N
  --syntax        Enable syntax highlighting (if terminal supports)

Examples:
  euler read README.md
  euler read src/index.ts --lines 50
  euler read package.json --from 10 --lines 20`;
    }

    const { readFileSync, existsSync } = await import('fs');

    if (!existsSync(path)) {
      return `File not found: ${path}`;
    }

    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n');

      // Handle options
      const maxLines = args?.includes('--lines') ? parseInt(args[args.indexOf('--lines') + 1] || '0') : lines.length;
      const fromLine = args?.includes('--from') ? parseInt(args[args.indexOf('--from') + 1] || '1') : 1;

      const displayLines = lines.slice(fromLine - 1, maxLines ? fromLine - 1 + maxLines : undefined);

      return displayLines.map((line, i) => `${fromLine + i}│${line}`).join('\n');
    } catch (error) {
      return `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
};
