/**
 * Setup command - Following oh-my-pi CLI architecture
 * Initial setup wizard
 */

export default {
  name: 'setup',
  description: 'Initial setup wizard',
  handler: async (args: string[]) => {
    const { existsSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const path = await import('path');

    const eulerDir = join(homedir(), '.euler');

    if (existsSync(eulerDir)) {
      return `Euler already configured at ${eulerDir}\nRun 'euler config show' to view settings.`;
    }

    console.log(`Setting up Euler at ${eulerDir}...`);

    // Create directory structure
    mkdirSync(eulerDir, { recursive: true });
    mkdirSync(join(eulerDir, 'sessions'), { recursive: true });
    mkdirSync(join(eulerDir, 'plugins'), { recursive: true });

    // Create default config. ConfigManager.save takes Partial<Config>; only the
    // fields on the Config interface (provider, model, etc.) are persistable —
    // UI prefs like theme/editor aren't part of Config, so omit them here.
    const { ConfigManager } = await import('../config/config');
    const manager = new ConfigManager();
    await manager.save({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    return `Euler setup complete!

Config directory: ${eulerDir}
Sessions: ${join(eulerDir, 'sessions')}
Plugins: ${join(eulerDir, 'plugins')}

Run 'euler launch' to start a session.`;
  }
};
