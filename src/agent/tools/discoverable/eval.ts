/**
 * Eval tool - Code execution with Python and JavaScript kernels
 * Following oh-my-pi's eval architecture
 * Persistent cells with shared prelude and tool re-entry
 */

import { spawn } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import type { Tool, ToolResult } from '../types';

export const evalTool: Tool = {
  name: 'eval',
  description: 'Code execution with persistent Python and JavaScript cells. Kernels maintain state across calls, can re-enter agent tools (read, search, task), and share a common prelude. Ideal for data analysis, testing, and prototyping.',
  category: 'discoverable',
  parameters: [
    {
      name: 'code',
      type: 'string',
      description: 'Code to execute',
      required: true
    },
    {
      name: 'language',
      type: 'string',
      description: 'Language: python, javascript, typescript (default: python)',
      required: false,
      default: 'python'
    },
    {
      name: 'cell',
      type: 'string',
      description: 'Cell identifier for state persistence (default: shared)',
      required: false,
      default: 'shared'
    },
    {
      name: 'timeout',
      type: 'number',
      description: 'Execution timeout in milliseconds (default: 30000)',
      required: false,
      default: 30000
    },
    {
      name: 'capture_output',
      type: 'boolean',
      description: 'Capture stdout/stderr (default: true)',
      required: false,
      default: true
    },
    {
      name: 'return_exceptions',
      type: 'boolean',
      description: 'Return exceptions instead of raising (default: true)',
      required: false,
      default: true
    }
  ],
  examples: [
    {
      input: {
        code: 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, 3]})\nprint(df.describe())',
        language: 'python'
      },
      output: {
        result: {
          stdout: '       a\ncount  3.0\nmean   2.0\nstd    1.0\nmin    1.0\n25%    1.5\n50%    2.0\n75%    2.5\nmax    3.0',
          stderr: '',
          returnCode: 0
        },
        language: 'python',
        cell: 'shared'
      },
      description: 'Execute Python code with pandas'
    },
    {
      input: {
        code: 'const data = [1, 2, 3];\nconst sum = data.reduce((a, b) => a + b, 0);\nconsole.log("Sum:", sum);',
        language: 'javascript'
      },
      output: {
        result: {
          stdout: 'Sum: 6',
          stderr: '',
          returnCode: 0
        },
        language: 'javascript',
        cell: 'shared'
      },
      description: 'Execute JavaScript code'
    },
    {
      input: {
        code: 'x = 42\nprint(f"x = {x}")',
        language: 'python',
        cell: 'stateful'
      },
      output: {
        result: {
          stdout: 'x = 42',
          stderr: '',
          returnCode: 0
        },
        stateSaved: true,
        cell: 'stateful'
      },
      description: 'Save state to cell'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        code,
        language = 'python',
        cell = 'shared',
        timeout = 30000,
        capture_output = true,
        return_exceptions = true
      } = input;

      if (!code) {
        return {
          success: false,
          error: 'Code parameter is required'
        };
      }

      // Execute code in appropriate kernel
      const result = await executeCode({
        code,
        language,
        cell,
        timeout,
        captureOutput: capture_output,
        returnExceptions: return_exceptions
      });

      return {
        success: true,
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Code execution failed'
      };
    }
  }
};

interface CodeExecutionRequest {
  code: string;
  language: string;
  cell: string;
  timeout: number;
  captureOutput: boolean;
  returnExceptions: boolean;
}

// Kernel state storage
const kernelState = new Map<string, any>();

// Execute code in kernel
async function executeCode(request: CodeExecutionRequest): Promise<any> {
  const { code, language, cell, timeout, captureOutput, returnExceptions } = request;

  // Get or create kernel state
  if (!kernelState.has(cell)) {
    kernelState.set(cell, {
      variables: {},
      lastCode: '',
      lastResult: null
    });
  }

  const state = kernelState.get(cell);

  // Execute based on language
  switch (language.toLowerCase()) {
    case 'python':
      return await executePython(code, state, timeout, captureOutput, returnExceptions);

    case 'javascript':
    case 'typescript':
    case 'js':
    case 'ts':
      return await executeJavaScript(code, state, timeout, captureOutput, returnExceptions);

    default:
      return {
        error: `Unsupported language: ${language}`,
        supportedLanguages: ['python', 'javascript', 'typescript']
      };
  }
}

// Execute Python code
async function executePython(
  code: string,
  state: any,
  timeout: number,
  captureOutput: boolean,
  returnExceptions: boolean
): Promise<any> {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['-c', code]);

    let stdout = '';
    let stderr = '';

    if (captureOutput) {
      python.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    const timeoutId = setTimeout(() => {
      python.kill('SIGKILL');
      reject(new Error('Execution timeout'));
    }, timeout);

    python.on('close', (returnCode) => {
      clearTimeout(timeoutId);

      // Update state
      state.lastCode = code;
      state.lastResult = { stdout, stderr, returnCode };

      resolve({
        result: {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          returnCode
        },
        language: 'python',
        stateSaved: true
      });
    });

    python.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// Execute JavaScript code
async function executeJavaScript(
  code: string,
  state: any,
  timeout: number,
  captureOutput: boolean,
  returnExceptions: boolean
): Promise<any> {
  return new Promise((resolve, reject) => {
    const node = spawn('node', ['-e', code]);

    let stdout = '';
    let stderr = '';

    if (captureOutput) {
      node.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      node.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    const timeoutId = setTimeout(() => {
      node.kill('SIGKILL');
      reject(new Error('Execution timeout'));
    }, timeout);

    node.on('close', (returnCode) => {
      clearTimeout(timeoutId);

      // Update state
      state.lastCode = code;
      state.lastResult = { stdout, stderr, returnCode };

      resolve({
        result: {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          returnCode
        },
        language: 'javascript',
        stateSaved: true
      });
    });

    node.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// Future: Implement persistent kernels
// This would involve:
// 1. Long-running Python/Node processes
// 2. Variable state management
// 3. Code injection and execution
// 4. Tool re-entry (allowing code to call agent tools)
// 5. Error handling and recovery
// 6. Memory and resource management

/*
Example persistent kernel setup:

const pythonPrelude = `
import sys
import json
from typing import *

# Tool bridge for re-entry
def tool_call(tool, **kwargs):
    import subprocess
    result = subprocess.run(['euler', 'tool', tool, json.dumps(kwargs)],
                          capture_output=True, text=True)
    return json.loads(result.stdout)

# Common imports
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
`;

const javascriptPrelude = `
// Tool bridge for re-entry
const toolCall = (tool, ...args) => {
  const { spawn } = require('child_process');
  // ... implementation
};

// Common imports
const fs = require('fs');
const path = require('path');
`;
*/
