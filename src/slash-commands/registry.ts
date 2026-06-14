/**
 * Slash Commands Registry - Following oh-my-pi architecture
 * Comprehensive command system with subcommands and argument handling
 */

import type { SlashCommandSpec, ParsedSlashCommand, SlashCommandResult } from './types';

export { SlashCommandSpec, ParsedSlashCommand, SlashCommandResult };

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommandSpec>();

  register(spec: SlashCommandSpec): void {
    this.commands.set(spec.name, spec);

    // Register aliases
    if (spec.aliases) {
      for (const alias of spec.aliases) {
        this.commands.set(alias, spec);
      }
    }
  }

  get(name: string): SlashCommandSpec | undefined {
    return this.commands.get(name);
  }

  list(): SlashCommandSpec[] {
    // Deduplicate by name (aliases point to same spec)
    const unique = new Map<string, SlashCommandSpec>();
    for (const spec of this.commands.values()) {
      if (!unique.has(spec.name)) {
        unique.set(spec.name, spec);
      }
    }
    return Array.from(unique.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async execute(name: string, args?: string[]): Promise<SlashCommandResult> {
    const command = this.get(name);

    if (!command) {
      return {
        consumed: false,
        error: `Unknown command: ${name}. Type /help for available commands.`
      };
    }

    try {
      const output = await command.handler(args);
      return {
        consumed: true,
        output
      };
    } catch (error) {
      return {
        consumed: true,
        error: error instanceof Error ? error.message : 'Command failed'
      };
    }
  }

  /**
   * Parse slash command string into components
   */
  parse(input: string): ParsedSlashCommand {
    const parts = input.trim().split(/\s+/);
    const name = parts[0].slice(1); // Remove leading slash
    const args = parts.slice(1);
    const raw = input;

    return { name, args, raw };
  }

  /**
   * Get command with subcommand support
   */
  getCommand(name: string): SlashCommandSpec | undefined {
    return this.commands.get(name);
  }

  /**
   * Find commands matching query
   */
  search(query: string, limit: number = 10): SlashCommandSpec[] {
    const queryLower = query.toLowerCase();
    const matches = this.list().filter(cmd => {
      const nameMatch = cmd.name.toLowerCase().includes(queryLower);
      const descMatch = cmd.description.toLowerCase().includes(queryLower);
      return nameMatch || descMatch;
    });

    return matches.slice(0, limit);
  }

  /**
   * Get help text for a command
   */
  getHelp(name: string): string | undefined {
    const command = this.get(name);
    if (!command) return undefined;

    let help = `${command.name}: ${command.description}`;
    if (command.usage) {
      help += `\nUsage: ${command.usage}`;
    }
    if (command.aliases && command.aliases.length > 0) {
      help += `\nAliases: ${command.aliases.join(', ')}`;
    }
    if (command.subcommands && command.subcommands.length > 0) {
      help += '\n\nSubcommands:';
      for (const sub of command.subcommands) {
        help += `\n  ${sub.name}: ${sub.description}`;
        if (sub.usage) {
          help += ` (${sub.usage})`;
        }
      }
    }
    return help;
  }
}

/**
 * Global registry instance - initialized with built-in commands
 */
let globalRegistry: SlashCommandRegistry | null = null;

export function getSlashCommandRegistry(): SlashCommandRegistry {
  if (!globalRegistry) {
    const { initializeSlashCommands } = require('./comprehensive');
    globalRegistry = initializeSlashCommands();
  }
  return globalRegistry;
}

export function resetSlashCommandRegistry(): void {
  globalRegistry = null;
}