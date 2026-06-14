#!/usr/bin/env bun
/**
 * Terminal-Bench CLI.
 *
 * Usage:
 *   API_KEY=sk-... bun bench/run.ts --base-url=https://api.deepseek.com/v1 --model=deepseek-v4-flash
 *
 * The key comes from $API_KEY (or --api-key). The agent never picks the env var
 * name for you — you decide where the key lives.
 */

import { runTerminalBench, writeReport } from './sdk';

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

async function main() {
  const apiKey = arg('api-key') ?? process.env.API_KEY;
  const baseUrl = arg('base-url') ?? 'https://api.deepseek.com/v1';
  const model = arg('model') ?? 'deepseek-chat';
  const taskDir = arg('task-dir');
  const only = arg('only')?.split(',').map((s) => s.trim());
  const verbose = arg('verbose') === 'true';
  const maxToolRounds = arg('max-tool-rounds') ? Number(arg('max-tool-rounds')) : undefined;

  if (!apiKey) {
    console.error('No API key. Set $API_KEY or pass --api-key=... (the agent never hardcodes one).');
    process.exit(2);
  }

  const report = await runTerminalBench({
    apiKey,
    baseUrl,
    model,
    taskDir,
    only,
    verbose,
    maxToolRounds,
  });

  await writeReport(report, './bench/report.json');
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
