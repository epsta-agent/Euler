/**
 * Slash Commands Types - Following oh-my-pi architecture
 */

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  subcommands?: SlashCommand[];
  handler: (args?: string[]) => string | Promise<string>;
}

export interface ParsedSlashCommand {
  name: string;
  args: string[];
  subcommand?: string;
  raw: string;
}

export interface SlashCommandResult {
  consumed: boolean;
  output?: string;
  error?: string;
}

export interface SlashCommandSpec {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  subcommands?: Array<{
    name: string;
    description: string;
    usage?: string;
  }>;
  handler: (args?: string[]) => string | Promise<string>;
}

export interface TuiSlashCommandRuntime {
  ctx: any;
  output: (text: string) => Promise<void>;
  editor: any;
  statusLine: any;
  ui: any;
}
