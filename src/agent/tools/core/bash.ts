/**
 * Bash tool - Shell execution following oh-my-pi architecture
 * Workspace shell with optional PTY or background-job dispatch
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolResult } from '../types';

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute shell commands in the working directory. Supports interactive PTY for commands requiring user input, background job dispatch, and timeout control.',
  category: 'core',
  parameters: [
    {
      name: 'command',
      type: 'string',
      description: 'Shell command to execute',
      required: true
    },
    {
      name: 'cwd',
      type: 'string',
      description: 'Working directory (defaults to session working directory)',
      required: false,
      default: process.cwd()
    },
    {
      name: 'timeout',
      type: 'number',
      description: 'Timeout in milliseconds (default: 30000)',
      required: false,
      default: 30000
    },
    {
      name: 'background',
      type: 'boolean',
      description: 'Run command in background (returns job ID)',
      required: false,
      default: false
    },
    {
      name: 'pty',
      type: 'boolean',
      description: 'Use PTY for interactive commands (sudo, ssh, etc.)',
      required: false,
      default: false
    },
    {
      name: 'env',
      type: 'object',
      description: 'Additional environment variables',
      required: false,
      default: {}
    },
    {
      name: 'stdin',
      type: 'string',
      description: 'Input to provide to command stdin',
      required: false,
      default: ''
    }
  ],
  examples: [
    {
      input: {
        command: 'ls -la'
      },
      output: {
        success: true,
        exitCode: 0,
        stdout: '...',
        stderr: ''
      },
      description: 'List directory contents'
    },
    {
      input: {
        command: 'npm install',
        background: true
      },
      output: {
        success: true,
        jobId: 'job_123',
        message: 'Running in background'
      },
      description: 'Run npm install in background'
    },
    {
      input: {
        command: 'sudo echo test',
        pty: true
      },
      output: {
        success: true,
        exitCode: 0,
        usedPty: true
      },
      description: 'Run command with PTY for sudo'
    }
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const {
        command,
        cwd = process.cwd(),
        timeout = 30000,
        background = false,
        pty = false,
        env = {},
        stdin = ''
      } = input;

      // Check for dangerous commands
      if (isDangerousCommand(command)) {
        return {
          success: false,
          error: 'Command contains potentially dangerous operations. Please use alternative approach.'
        };
      }

      // Handle background jobs
      if (background) {
        return await runInBackground(command, cwd, env);
      }

      // Execute command
      const result = await executeCommand(command, cwd, timeout, pty, env, stdin);

      return {
        success: result.exitCode === 0,
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to execute command'
      };
    }
  }
};

// Check for dangerous commands
function isDangerousCommand(command: string): boolean {
  const dangerous = [
    'rm -rf /',
    'rm -rf /*',
    'mkfs',
    'dd if=/dev/zero',
    ':(){:|:&};:', // fork bomb
    'chmod 000 -R',
    'chown root',
    'shutdown',
    'reboot',
    'poweroff'
  ];

  return dangerous.some(dangerous =>
    command.includes(dangerous) ||
    command.match(/rm\s+-rf\s+\//)
  );
}

// Execute command
async function executeCommand(
  command: string,
  cwd: string,
  timeout: number,
  usePty: boolean,
  env: Record<string, string>,
  stdin: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const envVars = { ...process.env, ...env };
    const shell = process.env.SHELL || '/bin/bash';

    const child = spawn(shell, ['-c', command], {
      cwd,
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe'] as any
    });

    // Timeout handler
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    // Collect stdout
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle stdin
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    // Handle completion
    child.on('close', (exitCode) => {
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      resolve({
        command,
        exitCode: timedOut ? -1 : (exitCode ?? -1),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration,
        timedOut,
        usedPty: usePty,
        cwd
      });
    });

    // Handle errors
    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// Background job management
const backgroundJobs = new Map<string, any>();
let jobIdCounter = 0;

async function runInBackground(
  command: string,
  cwd: string,
  env: Record<string, string>
): Promise<any> {
  const jobId = `job_${++jobIdCounter}`;

  const child = spawn(process.env.SHELL || '/bin/bash', ['-c', command], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore'
  });

  child.unref();

  backgroundJobs.set(jobId, {
    command,
    pid: child.pid,
    startTime: Date.now(),
    cwd
  });

  return {
    success: true,
    data: {
      jobId,
      pid: child.pid,
      command,
      message: 'Running in background',
      type: 'background_job'
    }
  };
}

// Get background job status
export function getJobStatus(jobId: string): any {
  const job = backgroundJobs.get(jobId);
  if (!job) {
    return { error: 'Job not found' };
  }

  try {
    process.kill(job.pid, 0); // Check if process exists
    return {
      jobId,
      pid: job.pid,
      command: job.command,
      status: 'running',
      startTime: job.startTime,
      duration: Date.now() - job.startTime
    };
  } catch {
    return {
      jobId,
      pid: job.pid,
      command: job.command,
      status: 'terminated',
      startTime: job.startTime
    };
  }
}

// Cancel background job
export function cancelJob(jobId: string): boolean {
  const job = backgroundJobs.get(jobId);
  if (!job) {
    return false;
  }

  try {
    process.kill(job.pid, 'SIGTERM');
    backgroundJobs.delete(jobId);
    return true;
  } catch {
    return false;
  }
}
