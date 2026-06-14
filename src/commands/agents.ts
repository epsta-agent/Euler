/**
 * Agents command - Following oh-my-pi CLI architecture
 * Subagent coordination
 */

export default {
  name: 'agents',
  description: 'Subagent coordination',
  handler: async (args: string[]) => {
    const subcommand = args?.[0];

    switch (subcommand) {
      case 'list':
        return `Available subagents:

Core agents:
  - reader: File and directory reading
  - editor: Code editing and modifications
  - searcher: Code search and navigation
  - executor: Command execution

Specialized agents:
  - lsp: Language Server integration
  - debugger: Debug Adapter integration
  - web: Web search and browsing
  - planner: Planning and goal management

Use subagents via /task or the task tool in interactive sessions.`;

      case 'status':
        return 'No active subagents. Subagents are created on-demand during sessions.';

      case 'spawn':
        const agentType = args[1];
        if (!agentType) {
          return 'Usage: euler agents spawn <type> [prompt]';
        }
        const prompt = args.slice(2).join(' ');
        return `Agent spawning not yet implemented via CLI.\nUse 'euler launch' and the /task command in interactive sessions.`;

      default:
        return `Agents subcommands: list, status, spawn

For subagent coordination, use the interactive session:
  euler launch
  Then: /task <prompt>`;
    }
  }
};
