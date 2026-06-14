/**
 * Stats command - Following oh-my-pi CLI architecture
 * Usage statistics
 */

export default {
  name: 'stats',
  description: 'Usage statistics',
  handler: async (args: string[]) => {
    const { join } = await import('path');
    const { homedir } = await import('os');
    const { Database } = await import('bun:sqlite');

    const eulerDir = join(homedir(), '.euler');
    const dbPath = join(eulerDir, 'sessions', 'sessions.db');

    const { existsSync } = await import('fs');
    if (!existsSync(dbPath)) {
      return 'No session data found. Run `euler setup` first.';
    }

    const db = new Database(dbPath);

    // Get session stats
    const sessionCount = db.query('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messageCount = db.query('SELECT COUNT(*) as count FROM messages').get() as { count: number };

    // Get token usage (if available)
    let tokenStats = 'No token data';
    try {
      const tokens = db.query('SELECT SUM(input_tokens + output_tokens) as total FROM messages').get() as { total: number | null };
      if (tokens?.total) {
        tokenStats = `${tokens.total.toLocaleString()} tokens`;
      }
    } catch {
      // Token columns might not exist
    }

    db.close();

    return `Euler Usage Statistics
=====================

Sessions: ${sessionCount.count}
Messages: ${messageCount.count}
Tokens: ${tokenStats}

Data directory: ${eulerDir}`;
  }
};
