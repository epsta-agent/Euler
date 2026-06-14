/**
 * Euler Agent CLI - main entry point
 */

import React from 'react';
import { render } from 'ink';
import { App } from './tui/index';
import { ModelSelector } from './tui/components';
import { providerRegistry } from './agent/model/index';
import { AgentCoordinator } from './agent/agent/index';
import { tools } from './agent/tool/index';
import { ConfigManager } from './config/index';
import { SessionManager } from './sessions';
import { resolveCliArgv } from './cli-commands';
import type { ChatMessage } from './tui/types';

async function loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const manager = new SessionManager();
  const messages = await manager.getMessages(sessionId);
  manager.close();

  return messages.map((msg) => ({
    role: msg.role as any,
    content: msg.content,
  }));
}

async function selectProviderAndModel(): Promise<{ provider: string; model: string }> {
  const providers = [
    // Frontier APIs
    {
      name: 'anthropic',
      models: [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', provider: 'anthropic' },
      ],
      authenticated: !!process.env.ANTHROPIC_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'openai',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'openai' },
      ],
      authenticated: !!process.env.OPENAI_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'google',
      models: [
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'google' },
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google' },
        { id: 'gemini-1.5-pro-experimental', name: 'Gemini 1.5 Pro Experimental', provider: 'google' },
      ],
      authenticated: !!process.env.GOOGLE_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'mistral',
      models: [
        { id: 'mistral-large', name: 'Mistral Large', provider: 'mistral' },
        { id: 'mistral-medium', name: 'Mistral Medium', provider: 'mistral' },
        { id: 'codestral', name: 'Codestral', provider: 'mistral' },
        { id: 'mixtral-8x7b', name: 'Mixtral 8x7B', provider: 'mistral' },
      ],
      authenticated: !!process.env.MISTRAL_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'openrouter',
      models: [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (via OpenRouter)', provider: 'openrouter' },
        { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)', provider: 'openrouter' },
        { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro (via OpenRouter)', provider: 'openrouter' },
      ],
      authenticated: !!process.env.OPENROUTER_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'xai',
      models: [
        { id: 'grok-beta', name: 'Grok Beta', provider: 'xai' },
        { id: 'grok-vision-beta', name: 'Grok Vision Beta', provider: 'xai' },
      ],
      authenticated: !!process.env.XAI_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'cohere',
      models: [
        { id: 'command-r-plus', name: 'Command R Plus', provider: 'cohere' },
        { id: 'command-r', name: 'Command R', provider: 'cohere' },
      ],
      authenticated: !!process.env.COHERE_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'perplexity',
      models: [
        { id: 'llama-3.1-sonar-huge-128k-online', name: 'Llama 3.1 Sonar Huge 128k', provider: 'perplexity' },
        { id: 'llama-3.1-sonar-large-128k-online', name: 'Llama 3.1 Sonar Large 128k', provider: 'perplexity' },
      ],
      authenticated: !!process.env.PERPLEXITY_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'groq',
      models: [
        { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B Versatile', provider: 'groq' },
        { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', provider: 'groq' },
      ],
      authenticated: !!process.env.GROQ_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'deepseek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek' },
        { id: 'deepseek-coder', name: 'DeepSeek Coder', provider: 'deepseek' },
      ],
      authenticated: !!process.env.DEEPSEEK_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'fireworks',
      models: [
        { id: 'accounts/fireworks/models/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct', provider: 'fireworks' },
      ],
      authenticated: !!process.env.FIREWORKS_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'together',
      models: [
        { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B Instruct Turbo', provider: 'together' },
      ],
      authenticated: !!process.env.TOGETHER_API_KEY,
      category: 'frontier' as const,
    },
    {
      name: 'huggingface',
      models: [
        { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B Instruct', provider: 'huggingface' },
        { id: 'mistralai/Mistral-7B-Instruct-v0.2', name: 'Mistral 7B Instruct', provider: 'huggingface' },
      ],
      authenticated: !!process.env.HUGGINGFACE_API_KEY,
      category: 'frontier' as const,
    },

    // Coding Plans (Subscription-based)
    {
      name: 'cursor',
      models: [
        { id: 'cursor-small', name: 'Cursor Small', provider: 'cursor' },
        { id: 'cursor-large', name: 'Cursor Large', provider: 'cursor' },
      ],
      authenticated: !!process.env.CURSOR_API_KEY,
      category: 'coding-plan' as const,
    },
    {
      name: 'github-copilot',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o (via Copilot)', provider: 'github-copilot' },
        { id: 'copilot', name: 'Copilot', provider: 'github-copilot' },
      ],
      authenticated: !!process.env.GITHUB_TOKEN,
      category: 'coding-plan' as const,
    },

    // Local/Self-hosted
    {
      name: 'ollama',
      models: [
        { id: 'llama3:latest', name: 'Llama 3 (Latest)', provider: 'ollama' },
        { id: 'llama3:instruct', name: 'Llama 3 Instruct', provider: 'ollama' },
        { id: 'mistral:7b', name: 'Mistral 7B', provider: 'ollama' },
        { id: 'codellama:instruct', name: 'Code Llama Instruct', provider: 'ollama' },
      ],
      authenticated: true, // Ollama doesn't require API key
      category: 'local' as const,
    },
    {
      name: 'lm-studio',
      models: [
        { id: 'local-model', name: 'Local Model', provider: 'lm-studio' },
      ],
      authenticated: true, // LM Studio doesn't require API key
      category: 'local' as const,
    },
    {
      name: 'vllm',
      models: [
        { id: 'vllm-model', name: 'vLLM Model', provider: 'vllm' },
      ],
      authenticated: true, // vLLM doesn't require API key
      category: 'local' as const,
    },
  ];

  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(ModelSelector, {
        providers,
        onSelect: (provider, model) => {
          resolve({ provider, model });
        },
      })
    );
  });
}

async function executeCommand(name: string, args: string[]): Promise<void> {
  const { commands } = await import('./cli-commands');
  const command = commands.find(c => c.name === name || c.aliases?.includes(name));

  if (!command) {
    console.error(`Unknown command: ${name}`);
    console.error(`Available commands: ${commands.map(c => c.name).join(', ')}`);
    process.exit(1);
  }

  const module = await command.load();
  const handler = module.default.handler || module.default;
  const result = await handler(args);

  if (result) {
    console.log(result);
  }
}

async function showHelp(): Promise<void> {
  const { commands } = await import('./cli-commands');

  console.log(`
Euler Agent v0.1.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AI Coding Agent with multi-provider LLM support

USAGE:
  euler [command] [arguments]

INTERACTIVE MODE:
  euler                    Launch interactive session
  euler [prompt]           Launch session with initial prompt
  euler --resume          Resume most recent session
  euler --session <n>      Load specific session

COMMANDS:
${commands.map(c => {
    const aliases = c.aliases ? ` (${c.aliases.join(', ')})` : '';
    return `  ${c.name}${aliases.padEnd(20)} ${c.description}`;
  }).join('\n')}

OPTIONS:
  -h, --help              Show this help message
  -v, --version           Show version information
  -m, --select-model      Select provider and model
  -r, --resume            Resume most recent session

EXAMPLES:
  euler launch              Start interactive session
  euler config show         Show configuration
  euler "Fix the bug"       Start with initial prompt
  euler grep "TODO" src/    Search for TODOs in src/

For more information, visit: https://github.com/yourusername/euler
`);
}

async function showVersion(): Promise<void> {
  console.log('Euler Agent v0.1.0');
}

async function main(): Promise<void> {
  // Parse command line args
  const args = process.argv.slice(2);

  // Handle help/version
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    await showHelp();
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    await showVersion();
    return;
  }

  // Resolve CLI argv to determine if we should run a command or launch TUI
  const resolved = resolveCliArgv(args);

  if ('error' in resolved) {
    console.error(resolved.error);
    process.exit(1);
  }

  const resolvedArgs = resolved.argv;
  const commandName = resolvedArgs[0];

  // Check if this is a subcommand (not "launch")
  if (commandName && commandName !== 'launch') {
    await executeCommand(commandName, resolvedArgs.slice(1));
    return;
  }

  // Interactive mode (launch or default)
  const resumeIndex = resolvedArgs.indexOf('--resume') !== -1 || resolvedArgs.indexOf('-r') !== -1;
  const sessionIndex = resolvedArgs.indexOf('--session');
  const sessionArg = sessionIndex !== -1 ? resolvedArgs[sessionIndex + 1] : undefined;
  const selectModelIndex = resolvedArgs.indexOf('--select-model') !== -1 || resolvedArgs.indexOf('-m') !== -1;

  // Check if running in a TTY
  if (!process.stdin.isTTY) {
    console.error('Error: Euler Agent requires a TTY to run in interactive mode.');
    console.error('Make sure you\'re running in a terminal that supports raw mode.');
    console.error('');
    console.error('If you want to run a command non-interactively, use:');
    console.error('  euler <command> [args]');
    console.error('');
    console.error('Available commands: config, stats, grep, read, shell, ssh, search, plugin, setup, worktree, update');
    process.exit(1);
  }

  const configManager = new ConfigManager();
  const config = await configManager.load();

  // Check if we need to select a model
  let selectedProvider = config.provider;
  let selectedModel = config.model;

  // Only prompt if explicitly requested OR if config is missing/invalid
  const needsSelection = selectModelIndex || !config.provider || !config.model || config.provider === '' as any || config.model === '';

  if (needsSelection) {
    const selection = await selectProviderAndModel();
    selectedProvider = selection.provider as any;
    selectedModel = selection.model;

    // Save to config
    await configManager.save({
      provider: selection.provider as any,
      model: selection.model,
    });
  }

  const provider = providerRegistry.get(selectedProvider);
  if (!provider) {
    console.error(`Provider not found: ${selectedProvider}`);
    process.exit(1);
  }

  const coordinator = new AgentCoordinator(provider, tools, {
    provider: selectedProvider,
    model: selectedModel,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    systemPrompt: config.systemPrompt || 'You are Euler, a helpful coding assistant.',
  });

  // Load session if requested
  let initialMessages: ChatMessage[] = [];
  if (sessionArg) {
    try {
      const manager = new SessionManager();
      const sessions = await manager.listSessions();
      const sessionNum = parseInt(sessionArg, 10);

      if (sessionNum > 0 && sessionNum <= sessions.length) {
        const session = sessions[sessionNum - 1];
        console.error(`Loading session: ${session.metadata.name || session.metadata.id.substring(0, 8)}`);
        initialMessages = await loadSessionMessages(session.id);
      } else {
        console.error(`Invalid session number: ${sessionArg}`);
      }
    } catch (error) {
      console.error(`Failed to load session: ${error}`);
    }
  } else if (resumeIndex) {
    try {
      const manager = new SessionManager();
      const recentSession = manager.getMostRecentSession();
      if (recentSession) {
        console.error(`Resuming session: ${recentSession.name || recentSession.id.substring(0, 8)}`);
        initialMessages = await loadSessionMessages(recentSession.id);
      } else {
        console.error('No previous sessions found');
      }
      manager.close();
    } catch (error) {
      console.error(`Failed to resume session: ${error}`);
    }
  }

  const { waitUntilExit } = render(
    React.createElement(App, {
      provider: selectedProvider,
      model: selectedModel,
      onSubmit: async (input: string) => {
        return await coordinator.process(input);
      },
      initialMessages,
    }),
  );

  await waitUntilExit();
}

main().catch((error) => {
  console.error('Error starting Euler Agent:', error);
  process.exit(1);
});
