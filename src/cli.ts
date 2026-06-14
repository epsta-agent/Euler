/**
 * Euler Agent CLI - main entry point
 */

import { render } from 'ink';
import { App } from './tui/index.ts';
import { providerRegistry } from './agent/model/index.ts';
import { AgentCoordinator } from './agent/agent/index.ts';
import { tools } from './agent/tool/index.ts';
import { ConfigManager } from './config/index.ts';

async function main(): Promise<void> {
  const configManager = new ConfigManager();
  const config = await configManager.load();

  const provider = providerRegistry.get(config.provider as any);
  if (!provider) {
    console.error(`Provider not found: ${config.provider}`);
    process.exit(1);
  }

  const coordinator = new AgentCoordinator(provider, tools, {
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    systemPrompt: config.systemPrompt || 'You are Euler, a helpful coding assistant.',
  });

  const { waitUntilExit } = render(
    <App
      provider={config.provider}
      model={config.model}
      onSubmit={async (input) => {
        return await coordinator.process(input);
      }}
    />,
  );

  await waitUntilExit();
}

main().catch((error) => {
  console.error('Error starting Euler Agent:', error);
  process.exit(1);
});
