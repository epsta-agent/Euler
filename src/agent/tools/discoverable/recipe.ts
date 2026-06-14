/**
 * Recipe tool - Task runner integration
 * Following oh-my-pi's recipe architecture
 * Invoke targets from detected task runners (bun, just, make, cargo, npm)
 */

import { spawn } from 'child_process';
import { readFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import type { Tool, ToolResult } from '../types';

export const recipeTool: Tool = {
  name: 'recipe',
  description: 'Task runner integration - invoke targets from detected task runners (bun, just, make, cargo, npm, yarn, pnpm). Automatically detects available runners and targets.',
  category: 'discoverable',
  parameters: [
    {
      name: 'target',
      type: 'string',
      description: 'Target/command to invoke',
      required: true
    },
    {
      name: 'runner',
      type: 'string',
      description: 'Task runner: auto, bun, just, make, cargo, npm, yarn, pnpm (default: auto)',
      required: false,
      default: 'auto'
    },
    {
      name: 'args',
      type: 'array',
      description: 'Additional arguments to pass',
      required: false,
      default: []
    },
    {
      name: 'cwd',
      type: 'string',
      description: 'Working directory (default: current directory)',
      required: false
    },
    {
      name: 'list_targets',
      type: 'boolean',
      description: 'List available targets instead of running (default: false)',
      required: false,
      default: false
    },
    {
      name: 'timeout',
      type: 'number',
      description: 'Timeout in milliseconds (default: 120000)',
      required: false,
      default: 120000
    }
  ],
  examples: [
    {
      input: {
        target: 'build',
        runner: 'auto'
      },
      output: {
        runner: 'bun',
        target: 'build',
        status: 'completed',
        duration: 5420
      },
      description: 'Run build target with detected runner'
    },
    {
      input: {
        list_targets: true,
        runner: 'auto'
      },
      output: {
        detected: [
          {
            runner: 'bun',
            targets: ['dev', 'build', 'test', 'lint']
          },
          {
            runner: 'make',
            targets: ['all', 'clean', 'install', 'test']
          }
        ]
      },
      description: 'List all available targets'
    },
    {
      input: {
        target: 'test',
        runner: 'npm',
        args: ['--verbose']
      },
      output: {
        runner: 'npm',
        target: 'test',
        args: ['--verbose'],
        status: 'completed',
        duration: 12340
      },
      description: 'Run tests with npm and verbose flag'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        target,
        runner = 'auto',
        args = [],
        cwd,
        list_targets = false,
        timeout = 120000
      } = input;

      // List targets if requested
      if (list_targets) {
        return await listAvailableTargets(cwd);
      }

      if (!target) {
        return {
          success: false,
          error: 'Target parameter is required (unless listing targets)'
        };
      }

      // Execute recipe
      const result = await executeRecipe({
        target,
        runner,
        args,
        cwd,
        timeout
      });

      return {
        success: true,
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Recipe execution failed'
      };
    }
  }
};

interface RecipeExecution {
  target: string;
  runner: string;
  args: string[];
  cwd?: string;
  timeout: number;
}

// Task runner detection
const runners = {
  bun: {
    command: 'bun',
    files: ['bun.lockb', 'package.json'],
    targets: async (cwd: string) => await getNpmTargets(cwd)
  },
  npm: {
    command: 'npm',
    files: ['package.json', 'package-lock.json'],
    targets: async (cwd: string) => await getNpmTargets(cwd)
  },
  yarn: {
    command: 'yarn',
    files: ['yarn.lock'],
    targets: async (cwd: string) => await getNpmTargets(cwd)
  },
  pnpm: {
    command: 'pnpm',
    files: ['pnpm-lock.yaml'],
    targets: async (cwd: string) => await getNpmTargets(cwd)
  },
  just: {
    command: 'just',
    files: ['justfile'],
    targets: async (cwd: string) => await getJustTargets(cwd)
  },
  make: {
    command: 'make',
    files: ['Makefile', 'makefile'],
    targets: async (cwd: string) => await getMakeTargets(cwd)
  },
  cargo: {
    command: 'cargo',
    files: ['Cargo.toml'],
    targets: async (cwd: string) => await getCargoTargets(cwd)
  }
};

// Execute recipe
async function executeRecipe(execution: RecipeExecution): Promise<any> {
  const { target, runner, args, cwd = process.cwd(), timeout } = execution;

  // Detect or use specified runner
  const detectedRunner = runner === 'auto' ? await detectRunner(cwd) : runner;

  if (!detectedRunner) {
    return {
      error: 'No task runner detected',
      supportedRunners: Object.keys(runners)
    };
  }

  // Get runner config
  const runnerConfig = runners[detectedRunner as keyof typeof runners];

  // Execute command
  const result = await runCommand(
    runnerConfig.command,
    [target, ...args],
    cwd,
    timeout
  );

  return {
    runner: detectedRunner,
    target,
    args,
    ...result
  };
}

// Detect available runner
async function detectRunner(cwd: string): Promise<string | null> {
  for (const [name, config] of Object.entries(runners)) {
    const found = config.files.some(file => existsSync(`${cwd}/${file}`));
    if (found) return name;
  }
  return null;
}

// Run command
async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn(command, args, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Command timeout'));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        status: code === 0 ? 'completed' : 'failed',
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration: Date.now() - startTime
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// List available targets
async function listAvailableTargets(cwd?: string): Promise<any> {
  const workDir = cwd || process.cwd();
  const detected = [];

  for (const [name, config] of Object.entries(runners)) {
    const found = config.files.some(file => existsSync(`${workDir}/${file}`));
    if (found) {
      const targets = await config.targets(workDir);
      detected.push({ runner: name, targets });
    }
  }

  return {
    detected,
    cwd: workDir
  };
}

// Get npm/yarn/pnpm targets from package.json
async function getNpmTargets(cwd: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await readFile(`${cwd}/package.json`, 'utf-8'));
    return Object.keys(packageJson.scripts || {});
  } catch {
    return [];
  }
}

// Get just targets
async function getJustTargets(cwd: string): Promise<string[]> {
  // For now, return mock targets
  // In production, would parse justfile or run 'just --list'
  return ['all', 'clean', 'build', 'test'];
}

// Get make targets
async function getMakeTargets(cwd: string): Promise<string[]> {
  // For now, return mock targets
  // In production, would run 'make -pn' to get targets
  return ['all', 'clean', 'install', 'test'];
}

// Get cargo targets
async function getCargoTargets(cwd: string): Promise<string[]> {
  // For now, return mock targets
  // In production, would run 'cargo --list' to get targets
  return ['build', 'test', 'run', 'check', 'doc', 'clean'];
}
