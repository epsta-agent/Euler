/**
 * Update command - Following oh-my-pi CLI architecture
 * Update Euler Agent
 */

export default {
  name: 'update',
  description: 'Update Euler Agent',
  handler: async (args: string[]) => {
    const { execSync } = await import('child_process');

    const flag = args?.[0];

    if (flag === '--help' || flag === '-h') {
      return `Usage: euler update [options]

Check for and apply updates to Euler Agent.

Options:
  --check-only    Only check for updates, don't install
  --force         Force update even if already latest`;
    }

    try {
      // Get current version
      const packageJson = await import('../package.json');
      const currentVersion = packageJson.version || '0.0.0';

      // Check if we're in a git repository
      try {
        execSync('git rev-parse --git-dir', { stdio: 'ignore' });

        if (flag === '--check-only') {
          const latest = execSync('git fetch origin && git rev-parse origin/main', { encoding: 'utf-8' }).trim();
          const current = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

          if (latest === current) {
            return `Already up to date (v${currentVersion})`;
          }
          return `Update available: ${current.substring(0, 8)} → ${latest.substring(0, 8)}`;
        }

        return `Update not yet implemented via CLI.

To update manually:
  git pull origin main
  bun install
  bun run build`;

      } catch {
        return 'Not a git repository. Manual update required.';
      }
    } catch (error) {
      return `Update check failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
};
