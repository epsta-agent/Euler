/**
 * Agent drivers for the SWE-bench harness.
 *
 * A driver wires a model (via an OpenAI-compatible chat completions API) to the
 * Euler junior-friendly tool surface (read/write/edit/bash/grep/find/search),
 * runs a tool-use loop for a bounded number of turns, and edits files in the
 * task's repo directory. The driver is intentionally minimal: it does not
 * depend on the full agent runtime so the benchmark is reproducible and
 * isolated from TUI/session concerns.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { TaskSpec } from './harness';

export interface AgentTurn {
  role: 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

export interface AgentDriverResult {
  turns: number;
  error?: string;
}

export interface AgentDriver {
  (spec: TaskSpec, repoDir: string): Promise<AgentDriverResult>;
}

/** A tool descriptor the model can call: name, JSON schema, and a handler. */
interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  run: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

const SYSTEM_PROMPT = `You are an expert software engineer fixing a bug in a repository.

You have these tools:
- read(path, offset?, limit?): read a file (line-numbered output). Use this first to understand code.
- write(path, content): create or overwrite a file.
- edit(path, oldText, newText): replace an EXACT, unique block of text. oldText must match exactly once.
- bash(command, timeout?): run a shell command (e.g. run tests).
- grep(pattern, path?): search file contents.
- find(pattern, path?): find files by glob.

Rules:
1. First reproduce the bug: read the relevant files and run the failing test with bash.
2. Make a MINIMAL fix. Prefer edit() over rewriting whole files.
3. After editing, RE-RUN the failing test to confirm it passes.
4. Do not modify test files unless the task explicitly says the test itself is wrong.
5. Keep edits minimal and focused on the reported issue.
6. When done, respond with a one-line summary of the change. Do not call more tools.

Work entirely within the provided repository directory. Be concise.`;

/** Build the tool definitions bound to a working directory. */
function buildTools(cwd: string): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file (line-numbered). Use to inspect source.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to repo root.' },
            offset: { type: 'number', description: '1-indexed start line (optional).' },
            limit: { type: 'number', description: 'Max lines (optional).' },
          },
          required: ['path'],
        },
      },
      run: async (args) => {
        return runEulerTool('read', args, cwd);
      },
    },
    {
      type: 'function',
      function: {
        name: 'write',
        description: 'Create or overwrite a file with the given content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      run: async (args) => runEulerTool('write', args, cwd),
    },
    {
      type: 'function',
      function: {
        name: 'edit',
        description: 'Replace an EXACT, unique block of text in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string', description: 'Must match exactly once in the file.' },
            newText: { type: 'string' },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
      run: async (args) => runEulerTool('edit', args, cwd),
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command in the repo. Use to run tests.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'number', description: 'Timeout in ms (optional).' },
          },
          required: ['command'],
        },
      },
      run: async (args) => runEulerTool('bash', args, cwd),
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents for a regex pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Subdir to search (default repo root).' },
          },
          required: ['pattern'],
        },
      },
      run: async (args) => runEulerTool('grep', args, cwd),
    },
    {
      type: 'function',
      function: {
        name: 'find',
        description: 'Find files by glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
      run: async (args) => runEulerTool('find', args, cwd),
    },
  ];
}

/**
 * Dispatch to the actual Euler junior-friendly tools. We reuse the real tool
 * implementations from src/agent/tool so the benchmark exercises the same
 * code path the agent uses.
 */
async function runEulerTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<string> {
  // Tools resolve paths relative to process.cwd(); temporarily switch.
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    const { tools, getTool } = await import('../src/agent/tool/index.ts');
    const tool = getTool(name) ?? tools.find((t) => t.name === name);
    if (!tool) return `Error: unknown tool '${name}'.`;
    const result = await tool.execute(args);
    return result.content;
  } catch (err: any) {
    return `Error: ${err?.message ?? err}`;
  } finally {
    process.chdir(prev);
  }
}

/** A single chat-completions call with tool support. */
interface ChatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools: ToolDef[];
  maxTokens?: number;
}

interface ChatResponse {
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

async function chatCompletion(opts: ChatOptions): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 2048,
    stream: false,
  };
  if (opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: t.type,
      function: t.function,
    }));
  }

  const url = opts.baseURL.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`chat API ${resp.status}: ${text}`);
  }

  const data: any = await resp.json();
  const choice = data.choices?.[0]?.message ?? {};
  const content: string | null = typeof choice.content === 'string' ? choice.content : null;
  const toolCalls: ChatResponse['toolCalls'] = (choice.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name,
    arguments: safeParseArgs(tc.function?.arguments),
  }));
  return { content, toolCalls };
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

export interface DriverConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  verbose?: boolean;
}

/** Resolve provider base URL + API key from env/config. */
export function resolveProvider(cfg: {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'openrouter';
  apiKey?: string;
  baseURL?: string;
  model: string;
}): { baseURL: string; apiKey: string } {
  const defaults: Record<string, { baseURL: string; keyEnv: string }> = {
    deepseek: { baseURL: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
    openai: { baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
    anthropic: { baseURL: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
    openrouter: { baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  };
  const d = defaults[cfg.provider];
  const baseURL = cfg.baseURL ?? d.baseURL;
  const apiKey = cfg.apiKey ?? process.env[d.keyEnv] ?? '';
  return { baseURL, apiKey };
}

/** Create the standard agent driver bound to a model provider. */
export function createAgentDriver(cfg: DriverConfig): AgentDriver {
  return async (spec: TaskSpec, repoDir: string): Promise<AgentDriverResult> => {
    const tools = buildTools(repoDir);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Repository: ${repoDir}\n\n` +
          `Problem:\n${spec.problem_statement}\n\n` +
          `Failing test(s) to make pass:\n${spec.fail_to_pass.map((c) => `- \`${c}\``).join('\n')}\n\n` +
          `Fix the bug. You have up to ${cfg.maxTurns} tool calls.`,
      },
    ];

    let turns = 0;
    let nudged = false;
    try {
      while (turns < cfg.maxTurns) {
        turns++;
        const resp = await chatCompletion({
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages,
          tools,
        });

        // If the model produced text and no tool calls:
        //  - On the first occurrence, nudge it to actually apply the fix with a
        //    tool (weak models often describe the fix in prose instead of
        //    calling edit/write). This converts an answer into an action.
        //  - On the second occurrence, accept that the model is done.
        if (resp.toolCalls.length === 0) {
          if (resp.content) {
            messages.push({ role: 'assistant', content: resp.content });
          }
          if (!nudged && turns < cfg.maxTurns) {
            nudged = true;
            messages.push({
              role: 'user',
              content:
                'You have not yet applied the fix. Do not just describe the change — ' +
                'call the `edit` (or `write`) tool NOW to actually modify the file, ' +
                'then call `bash` to re-run the failing test to confirm it passes.',
            });
            if (cfg.verbose) console.log(`  [turn ${turns}] nudge: no tool call, re-prompting to apply fix`);
            continue;
          }
          break;
        }

        // Record the assistant turn (include its text + tool calls as a string
        // summary; some providers don't echo tool_calls back, which is fine).
        const assistantText =
          (resp.content ?? '') +
          resp.toolCalls
            .map((tc) => `\n[tool_call:${tc.name}(${JSON.stringify(tc.arguments)})]`)
            .join('');
        messages.push({ role: 'assistant', content: assistantText });

        // Execute each tool call and feed results back as user messages.
        for (const tc of resp.toolCalls) {
          const tool = tools.find((t) => t.function.name === tc.name);
          if (!tool) {
            messages.push({
              role: 'user',
              content: `Tool '${tc.name}' is not available. Available: ${tools
                .map((t) => t.function.name)
                .join(', ')}.`,
            });
            continue;
          }
          let result: string;
          try {
            result = (await tool.run(tc.arguments, repoDir)).slice(0, 6000);
          } catch (err: any) {
            result = `Error executing ${tc.name}: ${err?.message ?? err}`;
          }
          if (cfg.verbose) {
            console.log(`  [turn ${turns}] ${tc.name} → ${result.slice(0, 200).replace(/\n/g, ' ')}`);
          }
          messages.push({
            role: 'user',
            content: `Result of ${tc.name}:\n${result}`,
          });
        }
      }

      return { turns };
    } catch (err: any) {
      return { turns, error: err?.message ?? String(err) };
    }
  };
}
