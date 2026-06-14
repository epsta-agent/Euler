/**
 * CLI utilities - Following oh-my-pi architecture
 */

export interface CommandEntry {
  name: string;
  load: () => Promise<{ default: any }>;
  aliases?: string[];
}
