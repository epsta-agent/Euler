/**
 * Web search command - Following oh-my-pi CLI architecture
 * Web search using multiple providers
 */

export default {
  name: 'search',
  description: 'Web search',
  aliases: ['q'],
  handler: async (args: string[]) => {
    const query = args?.join(' ');

    if (!query) {
      return `Usage: euler search <query> | euler q <query>

Performs web search using multiple providers.

Examples:
  euler search "TypeScript generics"
  euler q "Bun runtime features"`;
    }

    try {
      // The agent's web_search tool lives in the discoverable tool surface,
      // which is only available inside the running agent loop. From the CLI we
      // don't have a live coordinator, so there's nothing to dispatch to.
      return `Web search is available inside the agent session (the \`web_search\` tool), not from this shell command. Run \`euler\` and ask the agent to search for "${query}".`;
    } catch (error) {
      return `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
};
