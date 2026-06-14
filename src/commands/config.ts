/**
 * Config command - Following oh-my-pi CLI architecture
 * Configuration management
 */

export default {
  name: 'config',
  description: 'Configuration management',
  handler: async (args: string[]) => {
    const { ConfigManager, getGlobalConfigPath } = await import('../config/config');
    const manager = new ConfigManager();
    const subcommand = args?.[0];

    switch (subcommand) {
      case 'get':
        const key = args[1];
        const config = await manager.load();
        if (key) {
          return `${key} = ${config[key as keyof typeof config] || 'undefined'}`;
        }
        return JSON.stringify(config, null, 2);

      case 'set':
        const setKey = args[1];
        const setValue = args[2];
        if (!setKey || !setValue) {
          return 'Usage: euler config set <key> <value>\n\nAvailable keys: provider, model, temperature, maxTokens, apiKey, systemPrompt';
        }

        // Parse value based on key
        let parsedValue: any = setValue;
        if (setKey === 'temperature' || setKey === 'maxTokens') {
          parsedValue = parseFloat(setValue);
          if (isNaN(parsedValue)) {
            return `Error: ${setKey} must be a number`;
          }
        }

        await manager.set(setKey as any, parsedValue);
        return `Set ${setKey} = ${parsedValue}`;

      case 'edit':
        const configPath = await getGlobalConfigPath();
        return `Config file: ${configPath}\n\nEdit this file to change configuration.`;

      case 'show':
        const currentConfig = await manager.load();
        return JSON.stringify(currentConfig, null, 2);

      default:
        const path = await getGlobalConfigPath();
        return `Config subcommands: get, set, edit, show

Current config: ${path}

Examples:
  euler config show           Show all config
  euler config get provider   Get specific value
  euler config set model gpt-4o  Set model`;
    }
  }
};
