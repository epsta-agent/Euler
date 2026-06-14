/**
 * ACP command - Following oh-my-pi CLI architecture
 * Agent Client Protocol mode for structured communication
 */

export default {
  name: 'acp',
  description: 'Agent Client Protocol mode',
  handler: async (args: string[]) => {
    const flag = args?.[0];

    if (flag === '--help' || flag === '-h') {
      return `Usage: euler acp [options]

Agent Client Protocol (ACP) provides structured communication between agents.

Options:
  --server    Run in server mode
  --client    Run in client mode
  --stdio     Use stdin/stdout for communication
  --port N    Use port N for socket communication`;
    }

    return `ACP mode is not yet fully implemented.

This will provide:
- Structured JSON-RPC over stdio
- Multi-turn agent coordination
- Subagent spawning and communication
- Tool call delegation

For now, use 'euler launch' for interactive sessions.`;
  }
};
