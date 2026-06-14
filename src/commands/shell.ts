/**
 * Shell command - Following oh-my-pi CLI architecture
 * Shell command utility
 */

export default {
  name: 'shell',
  description: 'Shell command utility',
  handler: async (args: string[]) => {
    const command = args?.join(' ');

    if (!command) {
      return `Usage: euler shell <command>

Execute shell commands and display output.

Options:
  --silent        Suppress command output
  --exit-code     Only return exit code

Examples:
  euler shell "ls -la"
  euler shell "git status"
  euler shell "bun test" --silent`;
    }

    const { execSync } = await import('child_process');

    const silent = args?.includes('--silent');
    const exitCodeOnly = args?.includes('--exit-code');

    try {
      if (silent) {
        execSync(command, { stdio: 'ignore' });
        return exitCodeOnly ? 'Exit code: 0' : '';
      }

      const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' });

      if (exitCodeOnly) {
        return 'Exit code: 0';
      }

      return output.trim();
    } catch (error) {
      const exitCode = (error as any).status || 1;
      if (exitCodeOnly) {
        return `Exit code: ${exitCode}`;
      }
      return `Command failed with exit code ${exitCode}`;
    }
  }
};
