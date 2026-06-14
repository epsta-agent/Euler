/**
 * Worktree command - Following oh-my-pi CLI architecture
 * Git worktree operations
 */

export default {
  name: 'worktree',
  description: 'Git worktree operations',
  aliases: ['wt'],
  handler: async (args: string[]) => {
    const { execSync } = await import('child_process');

    // Check if we're in a git repository
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    } catch {
      return 'Error: Not a git repository';
    }

    const subcommand = args?.[0];

    switch (subcommand) {
      case 'list':
        try {
          const output = execSync('git worktree list', { encoding: 'utf-8' });
          return `Git worktrees:\n${output}`;
        } catch {
          return 'Failed to list worktrees';
        }

      case 'add':
        const branch = args[1];
        const path = args[2];
        if (!branch) {
          return 'Usage: euler worktree add <branch> [path]';
        }
        try {
          const cmd = path
            ? `git worktree add ${path} ${branch}`
            : `git worktree add ${branch}`;
          const output = execSync(cmd, { encoding: 'utf-8' });
          return `Worktree created:\n${output}`;
        } catch (error) {
          return `Failed to create worktree: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }

      case 'remove':
      case 'prune':
        const worktreePath = args[1];
        if (!worktreePath) {
          return 'Usage: euler worktree remove <path>';
        }
        try {
          execSync(`git worktree remove ${worktreePath}`, { encoding: 'utf-8' });
          return `Worktree removed: ${worktreePath}`;
        } catch (error) {
          return `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }

      default:
        return `Worktree subcommands: list, add, remove, prune

Examples:
  euler worktree list
  euler worktree add feature-branch
  euler worktree add feature-branch ../feature-branch
  euler worktree remove ../feature-branch`;
    }
  }
};
