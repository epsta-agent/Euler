/**
 * CLI utilities - Following oh-my-pi architecture
 */

export interface CommandEntry {
  name: string;
  /** Optional human-readable description shown in help text. */
  description?: string;
  load: () => Promise<{ default: any }>;
  aliases?: string[];
}
