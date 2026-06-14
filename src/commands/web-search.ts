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
      // Try to use the web search tool
      const { webSearch } = await import('../agent/tools/discoverable/web-search');
      const results = await webSearch({ query });

      if (!results || results.length === 0) {
        return `No results found for "${query}"`;
      }

      let output = `Found ${results.length} results for "${query}":\n\n`;

      for (const result of results.slice(0, 5)) {
        output += `• ${result.title}\n  ${result.url}\n`;
        if (result.snippet) {
          output += `  ${result.snippet.substring(0, 100)}...\n`;
        }
        output += '\n';
      }

      return output;
    } catch (error) {
      return `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
};
