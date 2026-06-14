/**
 * Slash commands system - built-in and custom commands
 */

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args?: string[]) => string | Promise<string>;
}

class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  constructor() {
    // Register built-in commands
    this.register({
      name: 'model',
      description: 'Change the active model',
      handler: async (args) => {
        return `Model command: ${args?.[0] || 'Usage: /model <model_name>'}`;
      },
    });

    this.register({
      name: 'settings',
      description: 'Open settings menu',
      handler: async () => {
        return 'Settings menu - Feature coming soon';
      },
    });

    this.register({
      name: 'new',
      description: 'Start a new session',
      handler: async () => {
        return 'Starting new session...';
      },
    });

    this.register({
      name: 'export',
      description: 'Export session (HTML or JSON)',
      handler: async (args) => {
        const format = args?.[0] || 'html';
        return `Exporting session as ${format}...`;
      },
    });

    this.register({
      name: 'import',
      description: 'Import session from JSONL',
      handler: async (args) => {
        const path = args?.[0];
        return path ? `Importing session from ${path}...` : 'Usage: /import <path>';
      },
    });

    this.register({
      name: 'help',
      description: 'Show all available commands',
      handler: async () => {
        const lines = ['Available commands:'];
        for (const cmd of this.list()) {
          lines.push(`  /${cmd.name.padEnd(12)} - ${cmd.description}`);
        }
        return lines.join('\n');
      },
    });

    this.register({
      name: 'skill',
      description: 'Invoke a skill',
      handler: async (args) => {
        const skillName = args?.[0];
        return skillName ? `Invoking skill: ${skillName}` : 'Usage: /skill <skill_name>';
      },
    });

    this.register({
      name: 'quit',
      description: 'Exit Euler Agent',
      handler: async () => {
        process.exit(0);
        return 'Goodbye!'; // Never reached but keeps return type consistent
      },
    });

    this.register({
      name: 'resume',
      description: 'Resume a previous session',
      handler: async (args) => {
        const { SessionManager } = await import('../sessions');
        const manager = new SessionManager();
        const sessions = await manager.listSessions();

        if (sessions.length === 0) {
          return 'No previous sessions found. Type /new to start a new session.';
        }

        const lines = ['Previous sessions:'];
        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i];
          const date = new Date(session.metadata.updatedAt).toLocaleString();
          const name = session.metadata.name || session.metadata.id.substring(0, 8);
          lines.push(`  ${i + 1}. ${name} | ${session.messageCount} messages | ${date}`);
        }
        lines.push('\nTo resume a session, use: /resume <number>');
        return lines.join('\n');
      },
    });

    this.register({
      name: 'session',
      description: 'Show current session info',
      handler: async () => {
        return 'Session info - Feature coming soon';
      },
    });
  }

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  list(): SlashCommand[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async execute(name: string, args?: string[]): Promise<string> {
    const command = this.get(name);
    if (!command) {
      return `Unknown command: ${name}. Type /help for available commands.`;
    }
    return await command.handler(args);
  }
}

export const slashCommandRegistry = new SlashCommandRegistry();
