#!/usr/bin/env bun
/**
 * SWE-bench harness CLI entrypoint.
 *
 *   DEEPSEEK_API_KEY=... bun bench/run.ts [--task=<id>] [--max-turns=12] [--model=deepseek-chat]
 */

import {
  DEFAULT_CONFIG,
  evaluateTask,
  listTasks,
  loadTask,
  parseArgs,
  prepareWorkspace,
  summarize,
  writeReport,
} from './harness';
import { createAgentDriver, resolveProvider } from './drivers';

async function main() {
  const args = parseArgs(process.argv);
  const config = { ...DEFAULT_CONFIG, ...args } as typeof DEFAULT_CONFIG;

  const { baseURL, apiKey } = resolveProvider({
    provider: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
  });

  if (!apiKey) {
    console.error(
      `No API key found for provider '${config.provider}'. Set $${providerKeyEnv(config.provider)} or pass --api-key.`
    );
    process.exit(2);
  }

  const ids = await listTasks(config.taskDir);
  let chosen = ids;
  if (config.onlyTask) {
    chosen = ids.filter((id) => id === config.onlyTask);
    if (chosen.length === 0) {
      console.error(`Task '${config.onlyTask}' not found in ${config.taskDir}. Available: ${ids.join(', ') || '(none)'}`);
      process.exit(2);
    }
  }
  if (chosen.length === 0) {
    console.error(`No tasks found in ${config.taskDir}. Add task dirs with a task.json.`);
    process.exit(2);
  }

  console.log(`Provider: ${config.provider} (${config.model})`);
  console.log(`Tasks: ${chosen.join(', ')}`);
  console.log(`Max turns: ${config.maxTurns}`);
  console.log('');

  const driver = createAgentDriver({
    baseURL,
    apiKey,
    model: config.model,
    maxTurns: config.maxTurns,
    verbose: config.verbose,
  });

  const results = [];
  for (const id of chosen) {
    const spec = await loadTask(config.taskDir, id);
    console.log(`▶ ${id}`);
    const repoDir = await prepareWorkspace(config.taskDir, id, config.workRoot);
    const result = await evaluateTask(spec, repoDir, driver, config);
    results.push(result);
    console.log(`  → ${result.resolved ? 'RESOLVED' : 'NOT resolved'}`);
  }

  summarize(results);
  await writeReport(results, './bench/report.json');
}

function providerKeyEnv(provider: string): string {
  return {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  }[provider] ?? 'API_KEY';
}

main().catch((err) => {
  console.error('Harness failed:', err);
  process.exit(1);
});
