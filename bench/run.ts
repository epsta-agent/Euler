#!/usr/bin/env bun
/**
 * Terminal-Bench CLI.
 *
 * Usage:
 *   API_KEY=sk-... bun bench/run.ts --base-url=https://api.deepseek.com/v1 --model=deepseek-chat
 *
 * Flags:
 *   --api-key=...          API key (default: $API_KEY env var)
 *   --base-url=...         OpenAI-compatible endpoint (default: https://api.deepseek.com/v1)
 *   --model=...            model id (default: deepseek-chat)
 *   --only=a,b,c           only run these task ids
 *   --max-tool-rounds=N    tool-use rounds per attempt (default 24)
 *   --repair-rounds=N      near-miss repair attempts fed with real pytest output (default 1, 0 disables)
 *   --verbose=true         print per-turn tool activity
 *
 * The key comes from $API_KEY (or --api-key). The agent never picks the env var
 * name for you — you decide where the key lives.
 */

import { runTerminalBench, writeReport } from './sdk';

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}


/** Quick auth check: GET /v1/models with the key. Returns true iff 200/2xx. */
async function verifyApiKey(apiKey: string, baseUrl: string): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const apiKey = arg('api-key') ?? process.env.API_KEY;
  const baseUrl = arg('base-url') ?? 'https://api.deepseek.com/v1';
  const model = arg('model') ?? 'deepseek-chat';
  const taskDir = arg('task-dir');
  const only = arg('only')?.split(',').map((s) => s.trim());
  const verbose = arg('verbose') === 'true';
  const maxToolRounds = arg('max-tool-rounds') ? Number(arg('max-tool-rounds')) : undefined;
  const repairRounds = arg('repair-rounds') ? Number(arg('repair-rounds')) : undefined;

  if (!apiKey) {
    console.error('No API key. Set $API_KEY or pass --api-key=... (the agent never hardcodes one).');
    process.exit(2);
  }

  // Fast-fail on a bad/expired key BEFORE building any Docker image. A 401 here
  // saves the user from waiting through a slow build only to discover the key
  // is invalid. Skip only when the user passes --skip-auth-check.
  if (arg('skip-auth-check') !== 'true') {
    const ok = await verifyApiKey(apiKey, baseUrl);
    if (!ok) {
      console.error(
        `API key rejected by ${baseUrl} (or endpoint unreachable). ` +
        `Check the key and --base-url. Pass --skip-auth-check=true to bypass this guard.`
      );
      process.exit(2);
    }
    if (process.env.BENCH_VERBOSE) console.error(`auth OK against ${baseUrl}`);
  }

  const report = await runTerminalBench({
    apiKey,
    baseUrl,
    model,
    taskDir,
    only,
    verbose,
    maxToolRounds,
    repairRounds,
  });

  await writeReport(report, './bench/report.json');
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
