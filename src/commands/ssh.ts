/**
 * SSH command - Following oh-my-pi CLI architecture
 * Remote command execution
 */

export default {
  name: 'ssh',
  description: 'Remote command execution',
  handler: async (args: string[]) => {
    const host = args?.[0];

    if (!host) {
      return `Usage: euler ssh <host> [command]

Execute commands on remote hosts via SSH.

Options:
  -p, --port N    Use port N
  -l, --user USER Use username USER
  -i, --identity  Use identity file

Examples:
  euler ssh user@host "ls -la"
  euler ssh -p 2222 localhost "docker ps"
  euler ssh server "tail -f /var/log/app.log"`;
    }

    const { execSync } = await import('child_process');

    try {
      // Parse SSH options and command
      let sshArgs = [...(args || [])];
      let command = '';

      const cmdIndex = sshArgs.findIndex((arg, i) => i > 0 && !arg.startsWith('-'));
      if (cmdIndex > 0) {
        command = sshArgs.slice(cmdIndex).join(' ');
        sshArgs = sshArgs.slice(0, cmdIndex);
      }

      const sshCmd = command
        ? `ssh ${sshArgs.join(' ')} "${command}"`
        : `ssh ${sshArgs.join(' ')}`;

      const output = execSync(sshCmd, { encoding: 'utf-8', stdio: 'pipe' });
      return output.trim();
    } catch (error) {
      return `SSH command failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
};
