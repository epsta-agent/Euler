/**
 * Eval tool - code evaluation
 */

import { spawn } from 'child_process';
import type { Tool, ToolResult } from './types';

interface EvalInput {
  language: 'python' | 'javascript' | 'bun';
  code: string;
  context?: string;
}

function buildCommand(input: EvalInput): { cmd: string; args: string[] } {
  const { language, code, context } = input;

  if (language === 'python') {
    const pythonCode = context
      ? `import json\nctx = json.loads('''${context}''')\nexec('''${code}''')`
      : code;
    return { cmd: 'python3', args: ['-c', pythonCode] };
  }

  const jsCode = context ? `const ctx = ${context};\n${code}` : code;
  return { cmd: 'bun', args: ['-e', jsCode] };
}

export const evalTool: Tool = {
  name: 'eval',
  description: 'Execute Python or JavaScript code',
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript', 'bun'] },
      code: { type: 'string' },
      context: { type: 'string' },
    },
    required: ['language', 'code'],
  },
  execute: (input): Promise<ToolResult> => {
    const { language, code, context } = input as unknown as EvalInput;

    const { cmd, args } = buildCommand({ language, code, context });

    return new Promise((resolve) => {
      const proc = spawn(cmd, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve({ content: 'Execution timed out', isError: true });
      }, 30000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const output = stderr ? `${stdout}\n${stderr}` : stdout;
        resolve({ content: output || 'Execution completed', isError: code !== 0 });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({ content: `Execution error: ${error.message}`, isError: true });
      });
    });
  },
};
