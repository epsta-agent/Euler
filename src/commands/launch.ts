/**
 * Launch command - Following oh-my-pi CLI architecture
 * Main interactive agent session
 */

export default {
  name: 'launch',
  description: 'Launch interactive agent session',
  handler: async (args: string[]) => {
    // The launch command is the default - it runs the TUI
    // This is handled by the main CLI function
    // If we get here, it means we're being called from executeCommand
    // which shouldn't happen for launch

    return 'Launch command is handled by the main CLI function. Use: euler [args]';
  }
};
