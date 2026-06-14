/**
 * Task tool - spawn subagents for parallel work
 */

import type { Tool, ToolResult } from './types';
import { AgentCoordinator } from '../agent/coordinator';
import { providerRegistry } from '../model';

interface TaskInput {
  tasks: Array<{
    id: string;
    prompt: string;
    role?: 'default' | 'smol' | 'slow';
  }>;
  timeout?: number;
}

interface TaskResult {
  id: string;
  result: string;
  error?: string;
  duration: number;
}

interface TaskExecutor {
  id: string;
  prompt: string;
  role?: string;
}

async function executeTask(
  executor: TaskExecutor,
  timeout: number,
  getProvider: (role?: string) => any
): Promise<TaskResult> {
  const taskStart = Date.now();

  try {
    const provider = getProvider(executor.role);

    if (!provider) {
      throw new Error(`Provider not found for task: ${executor.id}`);
    }

    const coordinator = new AgentCoordinator(provider, [], {
      provider: executor.role || 'anthropic',
      model: 'default',
      temperature: 0.7,
      maxTokens: 4096,
    });

    const result = await Promise.race([
      coordinator.process(executor.prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeout)
      ),
    ]);

    return {
      id: executor.id,
      result,
      duration: Date.now() - taskStart,
    };

  } catch (error: any) {
    return {
      id: executor.id,
      result: '',
      error: error.message,
      duration: Date.now() - taskStart,
    };
  }
}

function formatResults(results: TaskResult[], duration: number): string {
  return `Completed ${results.length} tasks in ${duration}ms\n\n` +
    results.map(r =>
      `[${r.id}] (${r.duration}ms)\n${r.error ? `Error: ${r.error}` : r.result}`
    ).join('\n\n');
}

export const taskTool: Tool = {
  name: 'task',
  description: 'Spawn subagents to work on tasks in parallel',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            role: { type: 'string', enum: ['default', 'smol', 'slow'] },
          },
          required: ['id', 'prompt'],
        },
      },
      timeout: { type: 'number' },
    },
    required: ['tasks'],
  },
  execute: async (input): Promise<ToolResult> => {
    const { tasks, timeout = 120000 } = input as unknown as TaskInput;
    const startTime = Date.now();

    const results = await Promise.all(
      tasks.map(task => executeTask(task, timeout, (role?: string) => providerRegistry.getByRole(role || 'default')))
    );

    return { content: formatResults(results, Date.now() - startTime) };
  },
};
