/**
 * Euler CLI entry point.
 *
 * The TUI is now a Rust ratatui binary (native/euler-tui). This launcher:
 *   1. Routes known subcommands (config, grep, read, shell, ...) to the
 *      existing handlers in src/commands/ via cli-commands.ts.
 *   2. Otherwise launches the Rust TUI binary, passing through relevant flags.
 *
 * Replaces the old src/cli.tsx Ink entrypoint, which has been removed.
 */

import { commands, isSubcommand, resolveCliArgv } from './cli-commands';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const HELP = `euler — AI coding agent

Usage:
  euler                       Launch the interactive TUI (ratatui)
  euler --provider <p>        Start with a specific provider (deepseek, openai, ...)
  euler --model <m>           Start with a specific model id
  euler --resume              (reserved) resume most recent session
  euler <subcommand>          Run a CLI subcommand (config, grep, read, shell, ...)
  euler --help, -h            Show this help message

Environment:
  Provider API keys are read from env vars (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...).
  Set EULER_PROVIDER to default the provider.

The agent itself runs headless (src/headless.ts) as a subprocess of the TUI.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = require('../package.json');
    process.stdout.write(`euler ${pkg.version}\n`);
    return;
  }

  // If the first arg is a known subcommand, dispatch to the command handler.
  if (args.length > 0 && isSubcommand(args[0])) {
    const resolved = resolveCliArgv(args);
    if ('error' in resolved) {
      process.stderr.write(`error: ${resolved.error}\n`);
      process.exit(1);
    }
    const entry = commands.find((c) => c.name === args[0]);
    if (entry) {
      try {
        const mod = await entry.load();
        const out = await mod.default.handler(resolved.argv);
        if (typeof out === 'string' && out.length) process.stdout.write(out + '\n');
        return;
      } catch (err: any) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        process.exit(1);
      }
    }
  }

  // Otherwise: launch the Rust TUI binary. Prefer a release build, fall back
  // to debug, fall back to `cargo run` if neither is built yet.
  const tuiRelease = resolve(__dirname, '..', 'native', 'target', 'release', 'euler-tui');
  const tuiDebug = resolve(__dirname, '..', 'native', 'target', 'debug', 'euler-tui');

  if (existsSync(tuiRelease)) {
    spawnSync(tuiRelease, args, { stdio: 'inherit' });
  } else if (existsSync(tuiDebug)) {
    spawnSync(tuiDebug, args, { stdio: 'inherit' });
  } else {
    // No built binary — run via cargo (compiles on first run).
    process.stderr.write('(no prebuilt euler-tui binary; running via cargo — this may take a moment on first run)\n');
    const r = spawnSync(
      'cargo',
      ['run', '-p', 'euler-tui', '--', ...args],
      {
        cwd: resolve(__dirname, '..', 'native'),
        stdio: 'inherit',
      },
    );
    if (r.status !== 0 && r.error) {
      process.stderr.write(`failed to run euler-tui: ${r.error.message}\n`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`euler: ${err?.message ?? err}\n`);
  process.exit(1);
});
