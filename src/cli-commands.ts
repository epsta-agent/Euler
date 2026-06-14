/**
 * CLI Commands - Following oh-my-pi architecture
 * Top-level CLI commands matching oh-my-pi's command structure
 */

import type { CommandEntry } from './utils/cli';

export const commands: CommandEntry[] = [
  {
    name: "launch",
    description: "Launch interactive agent session",
    load: () => import('./commands/launch')
  },
  {
    name: "acp",
    description: "Agent Client Protocol mode",
    load: () => import('./commands/acp')
  },
  {
    name: "agents",
    description: "Subagent coordination",
    load: () => import('./commands/agents')
  },
  {
    name: "commit",
    description: "Atomic commit message generation",
    load: () => import('./commands/commit')
  },
  {
    name: "completions",
    description: "Shell completions",
    load: () => import('./commands/completions')
  },
  {
    name: "config",
    description: "Configuration management",
    load: () => import('./commands/config')
  },
  {
    name: "grep",
    description: "Fast file search",
    load: () => import('./commands/grep')
  },
  {
    name: "read",
    description: "File reader utility",
    load: () => import('./commands/read')
  },
  {
    name: "shell",
    description: "Shell command utility",
    load: () => import('./commands/shell')
  },
  {
    name: "ssh",
    description: "Remote command execution",
    load: () => import('./commands/ssh')
  },
  {
    name: "stats",
    description: "Usage statistics",
    load: () => import('./commands/stats')
  },
  {
    name: "search",
    description: "Web search",
    aliases: ["q"],
    load: () => import('./commands/web-search')
  },
  {
    name: "plugin",
    description: "Plugin management",
    load: () => import('./commands/plugin')
  },
  {
    name: "setup",
    description: "Initial setup wizard",
    load: () => import('./commands/setup')
  },
  {
    name: "worktree",
    description: "Git worktree operations",
    aliases: ["wt"],
    load: () => import('./commands/worktree')
  },
  {
    name: "update",
    description: "Update Euler Agent",
    load: () => import('./commands/update')
  },
];

/**
 * Reserved top-level words with helpful messages
 */
const RESERVED_TOP_LEVEL_WORDS = new Map<string, string>([
  [
    "extensions",
    '`euler extensions` is not a management command. Use `euler plugin list` / `euler plugin install`, or run `euler launch extensions` if you meant to send "extensions" as a prompt.',
  ],
  [
    "skills",
    '`euler skills` is not a management command. Skills are invoked with `/skill <name>` during interactive sessions.',
  ],
]);

/**
 * Return helpful error message for reserved words
 */
export function reservedTopLevelWordMessage(first: string | undefined, argc = 1): string | undefined {
  if (argc !== 1 || !first || first.startsWith("-") || first.startsWith("@")) return undefined;
  return RESERVED_TOP_LEVEL_WORDS.get(first);
}

/**
 * Check if first arg is a subcommand
 */
export function isSubcommand(first: string | undefined): boolean {
  if (!first || first.startsWith("-") || first.startsWith("@")) return false;
  return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

/**
 * Resolve CLI argv to route to appropriate command
 */
export function resolveCliArgv(argv: string[]): { argv: string[] } | { error: string } {
  const first = argv[0];
  const reservedMessage = reservedTopLevelWordMessage(first, argv.length);
  if (reservedMessage) return { error: reservedMessage };
  if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
    return { argv };
  }
  return { argv: isSubcommand(first) ? argv : ["launch", ...argv] };
}
