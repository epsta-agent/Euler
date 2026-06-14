/**
 * Complete command - Following oh-my-pi CLI architecture
 * Command completion helper
 */

export default {
  name: 'complete',
  description: 'Command completion helper (internal)',
  handler: async (args: string[]) => {
    const { commands } = await import('../cli-commands');

    const partial = args?.[0] || '';

    if (!partial) {
      return commands.map(c => c.name).join('\n');
    }

    const matches = commands
      .filter(c => c.name.startsWith(partial) || c.aliases?.some(a => a.startsWith(partial)))
      .map(c => c.name);

    return matches.join('\n');
  }
};
