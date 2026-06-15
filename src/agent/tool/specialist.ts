/**
 * Specialist tools for the agent.
 *
 * These exist because the terminal-bench failure logs showed the agent burning
 * many rounds hand-rolling fragile bash pipelines for tasks that have a known,
 * structured shape. Each tool collapses a multi-step bash ritual into one call
 * that returns STRUCTURED output — so the model spends its turns acting on
 * facts, not parsing command output.
 *
 * Design: every tool is a factory `makeXxxTool(exec, readFile?)` where `exec`
 * runs a shell command and returns {stdout, code}. This decouples the tool
 * LOGIC from WHERE it runs:
 *   - the TUI agent passes a local-shell exec,
 *   - the bench harness passes a docker-exec.
 * The same parsing/extraction code serves both.
 *
 * Concrete failures these tools address (from the bench logs):
 *   - latex_check:  overfull-hbox ran `pdflatex`+`grep overfull` 6+ times
 *                   across 3-4 round-trips each, and never identified the
 *                   offending word ("man-tic readi-ness"). This tool compiles
 *                   AND names the exact line + width + offending text in one call.
 *   - run_tests:    the agent discovered `python3 -m pytest` by trial and
 *                   parsed raw pytest text. This wraps the task verifier and
 *                   returns a per-test pass/fail summary.
 *   - inspect_env:  repeated `which python`, `apt list`, `pip install` discovery.
 *   - hex_dump:     `xxd`+`od -c` to reverse-engineer fixed-width binary data.
 */

/** Result of running a shell command. */
export interface ExecResult {
  stdout: string;
  code: number;
}

/** A function that runs a shell command in some environment (local or docker). */
export type ExecFn = (command: string, timeoutMs?: number) => Promise<ExecResult>;

import type { Tool, ToolResult } from './types';

const localExec = async (command: string, timeoutMs = 60_000): Promise<ExecResult> => {
  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout: stdout + (stderr ? '\n' + stderr : ''), code };
  } catch {
    return { stdout: '(command failed or timed out)', code: 124 };
  } finally {
    clearTimeout(timer);
  }
};

/* ============================================================================
 * latex_check — compile a .tex and extract structured box warnings.
 * ==========================================================================*/

export function makeLatexCheckTool(exec: ExecFn): Tool {
  return {
    name: 'latex_check',
    description:
      'Compile a LaTeX document and return STRUCTURED overfull/underfull \\hbox ' +
      'and \\vbox warnings — each with the line number, the amount too wide/tall, ' +
      'and the offending text. Use this instead of running pdflatex+grep by hand: ' +
      'it names the EXACT words causing each warning so you can reword them. ' +
      'Returns a clean pass/fail verdict plus the list of warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'The .tex file to compile (default main.tex).',
        },
        cwd: {
          type: 'string',
          description: 'Directory to compile in (default current dir).',
        },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const file = typeof r.file === 'string' && r.file ? r.file : 'main.tex';
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      // -interaction=nonstopmode so it never hangs waiting for input.
      // -halt-on-error=false so we still get box warnings after errors.
      const compile = await exec(
        `cd ${shq(cwd)} && pdflatex -interaction=nonstopmode -halt-on-error=false ${shq(file)} 2>&1`,
        60_000,
      );
      const log = await readLog(exec, cwd);
      const warnings = parseBoxWarnings(log ?? compile.stdout);
      const lines: string[] = [];
      if (compile.code !== 0 && warnings.length === 0) {
        // Compilation failed with no box warnings — surface the error tail.
        lines.push('Compilation FAILED (no box warnings — this is a LaTeX error, not an overfull box):');
        lines.push(compile.stdout.split('\n').slice(-25).join('\n'));
        return { content: lines.join('\n'), isError: true };
      }
      if (warnings.length === 0) {
        lines.push('✅ No overfull/underfull box warnings. Document compiles cleanly.');
        return { content: lines.join('\n'), isError: false };
      }
      lines.push(`❌ ${warnings.length} box warning${warnings.length === 1 ? '' : 's'} found:`);
      lines.push('');
      for (const w of warnings) {
        lines.push(
          `  • ${w.kind} (${w.dim}; ${w.amount} too ${w.too}) at lines ${w.lines}` +
          (w.text ? `:\n      "${w.text}"` : ''),
        );
      }
      lines.push('');
      // STEERING: name the next tool to call explicitly. The overfull-hbox bench
      // run showed the agent read these warnings but then hand-edited input.tex
      // (whack-a-mole) instead of using the preamble fix. Pointing at the tool
      // by name at the exact moment the warnings are seen is what converts the
      // failure — it makes the right action the path of least resistance.
      lines.push('NEXT STEP: call latex_fix_boxes now to fix these automatically by patching');
      lines.push('the preamble (emergencystretch). Do NOT hand-edit the flagged text — that');
      lines.push('creates new boxes elsewhere. latex_fix_boxes(file="' + file + '", cwd="' + cwd + '")');
      lines.push('applies the robust fix and re-checks in one call.');
      return { content: lines.join('\n'), isError: true };
    },
  };
}

/** Read main.log (or the matching .log) from cwd. */
async function readLog(exec: ExecFn, cwd: string): Promise<string | null> {
  // main.log is the conventional name; try it, then any *.log.
  const res = await exec(`cd ${shq(cwd)} && cat *.log 2>/dev/null`);
  if (res.code === 0 && res.stdout.trim()) return res.stdout;
  return null;
}

interface BoxWarning {
  kind: 'Overfull' | 'Underfull';
  box: 'hbox' | 'vbox';
  amount: string;   // "3.76862pt"
  too: 'wide' | 'tall';
  dim: string;      // "hbox"
  lines: string;    // "7--8"
  text: string;     // the offending text, if extractable
}

/** Parse LaTeX .log box warnings into structured form. */
export function parseBoxWarnings(log: string): BoxWarning[] {
  const out: BoxWarning[] = [];
  // Shape: "Overfull \hbox (3.76862pt too wide) in paragraph at lines 7--8"
  //        "Underfull \hbox (badness 1234) in paragraph at lines 12--13"
  const re = /(Overfull|Underfull)\s+\\?(hbox|vbox)\s*\(([^)]+)\)\s*(?:in paragraph at lines (\S+)|detected at line (\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const kind = m[1] as 'Overfull' | 'Underfull';
    const box = m[2] as 'hbox' | 'vbox';
    const paren = m[3];
    const linesRange = m[4] ?? (m[5] ? m[5] : '?');
    // "3.76862pt too wide" or "badness 1234"
    const amtMatch = paren.match(/([\d.]+pt)\s+too\s+(wide|tall)/);
    const amount = amtMatch ? amtMatch[1] : paren;
    const too = (amtMatch ? amtMatch[2] : box === 'hbox' ? 'wide' : 'tall') as 'wide' | 'tall';
    // The offending text usually follows on the next 1-3 lines, often as a
    // font-encoded fragment like "\OT1/cmr/m/n/10 man-tic readi-ness...".
    const after = log.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const text = extractOffendingText(after);
    out.push({ kind, box, amount, too, dim: box, lines: linesRange, text });
  }
  return out;
}

/** Pull readable words out of the post-warning log fragment. */
function extractOffendingText(fragment: string): string {
  // Drop font directives like \OT1/cmr/m/n/10 and keep the literal words.
  const cleaned = fragment
    .replace(/\\[A-Za-z0-9/]+\//g, '')   // font selectors
    .replace(/\[\]/g, '')
    .replace(/\n/g, ' ');
  // Grab up to the first [N] (page break marker) or end of readable run.
  const readable = cleaned.match(/([A-Za-z][A-Za-z\- ]{2,60})/);
  return readable ? readable[1].trim() : '';
}

/* ============================================================================
 * run_tests — run the task verifier and return a structured summary.
 * ==========================================================================*/

export function makeRunTestsTool(exec: ExecFn): Tool {
  return {
    name: 'run_tests',
    description:
      'Run the project test suite and return a STRUCTURED per-test summary: ' +
      'each test name with PASS/FAIL, plus the failing assertions. Use this ' +
      'instead of hand-discovering `python -m pytest` or `make test`. ' +
      'Auto-detects the test runner (pytest, cargo test, go test, make test, ' +
      'or an explicit command you supply).',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Explicit test command to run (default: auto-detect). E.g. "pytest -v", "cargo test", "go test ./...".',
        },
        cwd: {
          type: 'string',
          description: 'Directory to run in (default current dir).',
        },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      const cmd = typeof r.command === 'string' && r.command
        ? r.command
        : await autoDetectTestCommand(exec, cwd);
      if (!cmd) {
        return {
          content:
            'Could not auto-detect a test command. Pass one explicitly, e.g. ' +
            'command="pytest -v" or command="go test ./...".',
          isError: true,
        };
      }
      const res = await exec(`cd ${shq(cwd)} && ${cmd} 2>&1`, 120_000);
      const summary = parseTestSummary(res.stdout, cmd);
      return {
        content: summary,
        isError: res.code !== 0,
      };
    },
  };
}

/** Best-effort: detect the project's test command. */
async function autoDetectTestCommand(exec: ExecFn, cwd: string): Promise<string | null> {
  // If a terminal-bench test.sh exists, it's the grader — use it.
  const tb = await exec(`cd ${shq(cwd)} && test -f /tests/test.sh && echo yes || echo no`);
  if (tb.stdout.trim() === 'yes') return 'bash /tests/test.sh';
  const checks: Array<[string, string]> = [
    ['pytest', 'python3 -m pytest -v || python -m pytest -v'],
    ['cargo', 'cargo test'],
    ['go.mod', 'go test ./...'],
    ['package.json', 'npm test'],
    ['Makefile', 'make test'],
  ];
  for (const [marker, command] of checks) {
    const present = await exec(`cd ${shq(cwd)} && test -f ${shq(marker)} && echo yes || echo no`);
    if (present.stdout.trim() === 'yes') return command;
  }
  return null;
}

/** Turn pytest/cargo/go raw output into a compact per-test summary. */
export function parseTestSummary(stdout: string, cmd: string): string {
  const lines = stdout.split('\n');
  const passes: string[] = [];
  const fails: string[] = [];

  // pytest: "PASSED ../tests/test_outputs.py::test_foo" or "FAILED ...::test_bar"
  for (const line of lines) {
    const pm = line.match(/(?:PASSED|FAILED)\s+\S*?::(\w+)/);
    if (pm) {
      const t = line.includes('FAILED') ? fails : passes;
      // Capture the short test name.
      t.push(pm[1]);
      continue;
    }
    // pytest older: "test_foo ... ok" / "test_foo ... FAIL"
    const om = line.match(/^(\w+)\s+\.\.\.\s+(ok|FAIL|FAILED|ERROR|PASS|passed|failed|error)/i);
    if (om) {
      (om[2].toUpperCase().startsWith('FAIL') || om[2].toUpperCase() === 'ERROR' ? fails : passes).push(om[1]);
    }
    // cargo: "test result: FAILED. 3 passed; 1 failed;"
    // go: "FAIL\tmypkg/TestFoo [reversed]"
    const gm = line.match(/^(?:--- FAIL|FAIL)\b.*?(\w+)/);
    if (gm) fails.push(gm[1]);
  }

  // Final summary line (pytest "= N passed, M failed =", cargo "test result:").
  const summaryLine = lines.filter((l) =>
    /passed|failed|test result/i.test(l) && /=|:/.test(l),
  ).slice(-2);

  const out: string[] = [];
  if (passes.length === 0 && fails.length === 0) {
    // Couldn't parse — return the tail raw so the model still sees the result.
    out.push(`Ran: ${cmd}`);
    out.push(stdout.split('\n').slice(-30).join('\n'));
    return out.join('\n');
  }
  out.push(`Test results: ${passes.length} passed, ${fails.length} failed`);
  if (fails.length > 0) {
    out.push('');
    out.push('FAILED:');
    for (const f of fails) out.push(`  ❌ ${f}`);
  }
  if (passes.length > 0) {
    out.push('');
    out.push('PASSED:');
    for (const p of passes) out.push(`  ✅ ${p}`);
  }
  if (summaryLine.length) {
    out.push('');
    out.push(summaryLine.join('\n'));
  }
  return out.join('\n');
}

/* ============================================================================
 * inspect_env — what interpreters / package managers are installed.
 * ==========================================================================*/

export function makeInspectEnvTool(exec: ExecFn): Tool {
  return {
    name: 'inspect_env',
    description:
      'Report the installed language runtimes and package managers in the ' +
      'environment (python, node, go, rust/cargo, ruby, java, gcc, plus pip, ' +
      'uv, npm, apt) WITH versions. Use this ONCE at the start instead of ' +
      'running `which`/`apt list` repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory to inspect (default current).' },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      const tools = [
        'python3', 'python', 'pip', 'pip3', 'uv',
        'node', 'npm', 'npx', 'bun',
        'go', 'cargo', 'rustc',
        'ruby', 'gem', 'bundle',
        'java', 'javac', 'mvn', 'gradle',
        'gcc', 'g++', 'make', 'cmake',
        'apt-get', 'dpkg',
      ];
      const out: string[] = [];
      // One shell invocation that checks all tools at once — cheap.
      const script = tools
        .map((t) => `if command -v ${t} >/dev/null 2>&1; then printf "%s: " "${t}"; ${t} --version 2>&1 | head -1; fi`)
        .join('\n');
      const res = await exec(`cd ${shq(cwd)} && { ${script} ; }`, 30_000);
      out.push('Installed tools:');
      out.push(res.stdout.trim() || '(none of the common tools found)');
      // OS / arch for context.
      const uname = await exec('uname -srm 2>/dev/null');
      if (uname.stdout.trim()) out.push(`\nPlatform: ${uname.stdout.trim()}`);
      return { content: out.join('\n'), isError: false };
    },
  };
}

/* ============================================================================
 * hex_dump — structured hex+ascii view for binary / fixed-width data.
 * ==========================================================================*/

export function makeHexDumpTool(exec: ExecFn): Tool {
  return {
    name: 'hex_dump',
    description:
      'Hex+ASCII dump of a binary or fixed-width data file, with byte offsets. ' +
      'Use this to reverse-engineer binary record formats (the COBOL/DAT case) ' +
      'instead of composing `xxd`/`od -c` by hand. Optionally limit bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to dump.' },
        bytes: { type: 'number', description: 'Max bytes to show (default 512).' },
        offset: { type: 'number', description: 'Start byte offset (default 0).' },
      },
      required: ['path'],
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const path = r.path;
      if (typeof path !== 'string' || !path) {
        return { content: "Error: 'path' is required.", isError: true };
      }
      const bytes = typeof r.bytes === 'number' && r.bytes > 0 ? Math.min(r.bytes, 4096) : 512;
      const offset = typeof r.offset === 'number' && r.offset > 0 ? r.offset : 0;
      // `od -A x -t x1z` gives offset(hex) + hex bytes + ascii, very readable.
      const res = await exec(
        `od -A d -t x1z -v ${shq(path)} | awk 'NR>${Math.floor(offset / 16)}' | head -n ${Math.ceil(bytes / 16) + 1}`,
        15_000,
      );
      if (res.code !== 0) {
        return { content: `Error dumping '${path}': ${res.stdout.trim()}`, isError: true };
      }
      return { content: res.stdout, isError: false };
    },
  };
}

/* ============================================================================
 * diff_files — show the difference between two files or vs git HEAD.
 * ==========================================================================*/

export function makeDiffTool(exec: ExecFn): Tool {
  return {
    name: 'diff_files',
    description:
      'Show the line-level difference between two files, or between a file and ' +
      'its git HEAD version. Use this to verify an edit before committing, or to ' +
      'see what a previous step changed. Returns unified diff with context.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'First file path (or "HEAD:path" for git).' },
        b: { type: 'string', description: 'Second file path (omit to diff vs git HEAD).' },
        cwd: { type: 'string', description: 'Working directory (default current).' },
      },
      required: ['a'],
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const a = r.a;
      const b = typeof r.b === 'string' ? r.b : undefined;
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      if (typeof a !== 'string' || !a) {
        return { content: "Error: 'a' (file path) is required.", isError: true };
      }
      let cmd: string;
      if (b) {
        cmd = `cd ${shq(cwd)} && diff -u ${shq(a)} ${shq(b)} 2>&1`;
      } else {
        // Diff working tree vs git HEAD.
        cmd = `cd ${shq(cwd)} && git diff --no-color HEAD -- ${shq(a)} 2>&1`;
      }
      const res = await exec(cmd, 15_000);
      // diff exits 1 when there ARE differences (not an error).
      if (res.code === 0) {
        return { content: `(no differences)`, isError: false };
      }
      if (res.code === 2) {
        return { content: `Error running diff: ${res.stdout.trim()}`, isError: true };
      }
      return { content: res.stdout, isError: false };
    },
  };
}

/* ============================================================================
 * latex_fix_boxes — apply the standard preamble mitigations for overfull boxes.
 *
 * The overfull-hbox bench task revealed a whack-a-mole failure mode: editing
 * input.tex to fix one overfull box creates new ones elsewhere, because the
 * root cause is that LaTeX's line-breaking has nowhere to stretch. The robust
 * fix is a PREAMBLE change (\emergencystretch / \sloppy / \hbadness) which lets
 * LaTeX add extra inter-word spacing to absorb the overflow globally — no
 * content edits needed. This tool applies those mitigations idempotently and
 * re-checks, collapsing a 40-turn loop into one call.
 * ==========================================================================*/

export function makeLatexFixBoxesTool(exec: ExecFn): Tool {
  return {
    name: 'latex_fix_boxes',
    description:
      'Fix overfull/underfull \\hbox warnings by adding micro-typography ' +
      'tolerance to the LaTeX PREAMBLE (\\emergencystretch, \\sloppy, \\hbadness). ' +
      'Use this when latex_check shows overfull boxes — it is the robust fix and ' +
      'does NOT require editing the content. Re-compiles and reports the remaining ' +
      'warning count. Prefer this over hand-editing input text (which creates new boxes).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The .tex file whose preamble to patch (default main.tex).' },
        cwd: { type: 'string', description: 'Directory (default current).' },
        strategy: {
          type: 'string',
          description:
            'Which mitigation to apply: "emergencystretch" (default, safest — adds stretchable ' +
            'glue), "sloppy" (very loose), "hbadness" (suppress warnings only). ' +
            '"emergencystretch" is recommended and changes the visual output least.',
        },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const file = typeof r.file === 'string' && r.file ? r.file : 'main.tex';
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      const strategy = typeof r.strategy === 'string' && r.strategy ? r.strategy : 'emergencystretch';

      // The snippet to inject right after \begin{document} or \documentclass.
      // \emergencystretch adds up to 1em of extra stretchable glue per line,
      // which absorbs nearly all minor overfulls without the ugliness of \sloppy.
      const snippet =
        strategy === 'sloppy'
          ? '\\sloppy\n'
          : strategy === 'hbadness'
            ? '\\hbadness=10000\n\\vbadness=10000\n'
            : '\\setlength{\\emergencystretch}{1em}\n';

      // Read the current file.
      const readRes = await exec(`cat ${shq(file)}`, 10_000);
      if (readRes.code !== 0) {
        return { content: `Error: could not read ${file}: ${readRes.stdout.trim()}`, isError: true };
      }
      let content = readRes.stdout;

      // Idempotency: don't re-inject if already present.
      const marker = snippet.trim().split('\n')[0].split(/[={]/)[0];
      if (content.includes(marker)) {
        // Already patched — just re-check.
        return recompileAndReport(exec, cwd, file, '(preamble already patched)');
      }

      // Inject after \begin{document}; fall back to after \documentclass.
      let patched: string | null = null;
      if (content.includes('\\begin{document}')) {
        patched = content.replace(
          /\\begin\{document\}/,
          '\\begin{document}\n' + snippet,
        );
      } else if (content.includes('\\documentclass')) {
        patched = content.replace(
          /\\documentclass(\[[^\]]*\])?\{[^}]*\}/,
          (m) => m + '\n' + snippet,
        );
      }
      if (!patched) {
        return {
          content: `Error: could not find \\begin{document} or \\documentclass in ${file} to inject after.`,
          isError: true,
        };
      }

      // Write back via a heredoc to avoid quoting issues.
      const writeRes = await exec(`cat > ${shq(file)} <<'EULER_TEX_PATCH'\n${patched}EULER_TEX_PATCH`, 10_000);
      if (writeRes.code !== 0) {
        return { content: `Error writing ${file}: ${writeRes.stdout.trim()}`, isError: true };
      }

      return recompileAndReport(exec, cwd, file, `(applied ${strategy})`);
    },
  };
}

/** Recompile and report remaining box warnings. Shared with latex_check logic. */
async function recompileAndReport(
  exec: ExecFn,
  cwd: string,
  file: string,
  note: string,
): Promise<ToolResult> {
  await exec(
    `cd ${shq(cwd)} && pdflatex -interaction=nonstopmode -halt-on-error=false ${shq(file)} >/dev/null 2>&1`,
    60_000,
  );
  const logRes = await exec(`cd ${shq(cwd)} && cat *.log 2>/dev/null`);
  const warnings = parseBoxWarnings(logRes.stdout);
  if (warnings.length === 0) {
    return {
      content: `✅ ${note}. Recompiled ${file}: NO overfull/underfull box warnings remain.`,
      isError: false,
    };
  }
  const lines = [`⚠️ ${note}. Recompiled ${file}: ${warnings.length} box warning(s) still remain:`];
  for (const w of warnings) {
    lines.push(`  • ${w.kind} ${w.box} (${w.amount} too ${w.too}) at lines ${w.lines}` + (w.text ? `: "${w.text}"` : ''));
  }
  lines.push('');
  lines.push('If emergencystretch did not suffice, try strategy="sloppy", or reword the specific flagged text.');
  return { content: lines.join('\n'), isError: true };
}

/* ============================================================================
 * install_deps — detect and install project dependencies in one call.
 *
 * Observed in bench logs: agents burn 5-10 turns discovering whether the
 * project uses npm/pip/cargo, finding the right install command, and parsing
 * install output. This tool auto-detects the manifest and runs the canonical
 * install, returning a structured success/failure with the relevant tail.
 * ==========================================================================*/

export function makeInstallDepsTool(exec: ExecFn): Tool {
  return {
    name: 'install_deps',
    description:
      'Detect the project dependency manifest and install dependencies in one ' +
      'call: npm/bun/pnpm/yarn (package.json), pip/uv (requirements.txt or ' +
      'pyproject.toml), cargo (Cargo.toml), go (go.mod), or gem (Gemfile). ' +
      'Use this instead of hand-discovering the package manager and composing ' +
      'install commands. Returns a structured success/failure verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory (default current).' },
        manager: {
          type: 'string',
          description: 'Force a specific manager (npm, bun, pip, pip3, uv, cargo, go, gem). Default: auto-detect.',
        },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      const forced = typeof r.manager === 'string' && r.manager ? r.manager : null;

      let manager: string | null = forced;
      if (!manager) {
        manager = await autoDetectPackageManager(exec, cwd);
      }
      if (!manager) {
        return {
          content:
            'No dependency manifest found (no package.json, requirements.txt, pyproject.toml, ' +
            'Cargo.toml, go.mod, or Gemfile). Pass manager= to force one.',
          isError: true,
        };
      }

      const installCmd = installCommandFor(manager);
      if (!installCmd) {
        return { content: `Unknown package manager: ${manager}`, isError: true };
      }

      const res = await exec(`cd ${shq(cwd)} && ${installCmd} 2>&1`, 300_000);
      const tail = tailOutput(res.stdout, 40);
      // Package managers exit 0 on success, non-zero on failure. Some (npm)
      // return 0 even with warnings, so also scan the output for hard errors.
      const hasError = res.code !== 0;
      const lines: string[] = [`Ran: ${installCmd} (exit ${res.code})`];
      if (!hasError) {
        lines.push(`✅ Dependencies installed successfully via ${manager}.`);
      } else {
        lines.push(`❌ Install failed (exit ${res.code}).`);
        lines.push('');
        lines.push('Output tail:');
        lines.push(tail);
      }
      return { content: lines.join('\n'), isError: hasError };
    },
  };
}

/** Detect the package manager from the project files present. */
async function autoDetectPackageManager(exec: ExecFn, cwd: string): Promise<string | null> {
  const checks: Array<[string, string]> = [
    ['package.json', 'npm'],
    ['requirements.txt', 'pip'],
    ['pyproject.toml', 'pip'],
    ['Cargo.toml', 'cargo'],
    ['go.mod', 'go'],
    ['Gemfile', 'bundle'],
  ];
  for (const [marker, mgr] of checks) {
    const present = await exec(`cd ${shq(cwd)} && test -f ${shq(marker)} && echo yes || echo no`);
    if (present.stdout.trim() === 'yes') {
      // Prefer bun/yarn/pnpm over npm if package.json and they're available.
      if (marker === 'package.json') {
        const bun = await exec('command -v bun >/dev/null 2>&1 && echo yes || echo no');
        if (bun.stdout.trim() === 'yes') return 'bun';
        const yarn = await exec('command -v yarn >/dev/null 2>&1 && echo yes || echo no');
        if (yarn.stdout.trim() === 'yes') return 'yarn';
      }
      return mgr;
    }
  }
  return null;
}

/** Canonical install command for a manager. */
function installCommandFor(manager: string): string | null {
  switch (manager) {
    case 'npm': return 'npm install';
    case 'bun': return 'bun install';
    case 'yarn': return 'yarn install';
    case 'pnpm': return 'pnpm install';
    case 'pip': return 'pip install -r requirements.txt 2>/dev/null || pip install .';
    case 'pip3': return 'pip3 install -r requirements.txt 2>/dev/null || pip3 install .';
    case 'uv': return 'uv pip install -r requirements.txt 2>/dev/null || uv pip install .';
    case 'cargo': return 'cargo fetch';
    case 'go': return 'go mod download';
    case 'gem': return 'bundle install';
    case 'bundle': return 'bundle install';
    default: return null;
  }
}

/* ============================================================================
 * build — detect and run the project build, structured output.
 *
 * Replaces the agent hand-discovering `npm run build` / `cargo build` /
 * `make` / `pdflatex` and parsing the error output. Extracts the actual
 * compiler errors (file:line:message) into a structured list so the model
 * can fix them directly instead of scrolling raw build logs.
 * ==========================================================================*/

export function makeBuildTool(exec: ExecFn): Tool {
  return {
    name: 'build',
    description:
      'Detect and run the project build command (npm run build, cargo build, ' +
      'make, go build, pdflatex, tsc, etc.), returning a STRUCTURED result: ' +
      'success/failure plus extracted compiler errors with file:line:message. ' +
      'Use this instead of guessing the build command and parsing raw output.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory (default current).' },
        command: {
          type: 'string',
          description: 'Explicit build command (default: auto-detect from project files).',
        },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '.';
      const cmd = typeof r.command === 'string' && r.command
        ? r.command
        : await autoDetectBuildCommand(exec, cwd);
      if (!cmd) {
        return {
          content: 'Could not auto-detect a build command. Pass one explicitly, e.g. command="npm run build".',
          isError: true,
        };
      }
      const res = await exec(`cd ${shq(cwd)} && ${cmd} 2>&1`, 180_000);
      const errors = extractBuildErrors(res.stdout);
      const lines: string[] = [`Ran: ${cmd} (exit ${res.code})`];
      if (res.code === 0) {
        lines.push('✅ Build succeeded.');
        return { content: lines.join('\n'), isError: false };
      }
      lines.push('❌ Build FAILED.');
      if (errors.length > 0) {
        lines.push('');
        lines.push(`Extracted ${errors.length} error(s):`);
        for (const e of errors.slice(0, 15)) {
          lines.push(`  • ${e}`);
        }
        if (errors.length > 15) lines.push(`  ...and ${errors.length - 15} more (see raw output below)`);
      }
      lines.push('');
      lines.push('Output tail:');
      lines.push(tailOutput(res.stdout, 30));
      return { content: lines.join('\n'), isError: true };
    },
  };
}

/** Detect the build command from project files / scripts. */
async function autoDetectBuildCommand(exec: ExecFn, cwd: string): Promise<string | null> {
  // LaTeX
  const tex = await exec(`cd ${shq(cwd)} && ls *.tex 2>/dev/null | head -1`);
  if (tex.stdout.trim()) {
    const main = tex.stdout.trim().split('\n')[0];
    return `pdflatex -interaction=nonstopmode ${main}`;
  }
  // Make
  const make = await exec(`cd ${shq(cwd)} && test -f Makefile && echo yes || echo no`);
  if (make.stdout.trim() === 'yes') return 'make';
  // package.json build script
  const pkg = await exec(`cd ${shq(cwd)} && test -f package.json && grep -q '"build"' package.json && echo yes || echo no`);
  if (pkg.stdout.trim() === 'yes') return 'npm run build';
  // Rust
  const cargo = await exec(`cd ${shq(cwd)} && test -f Cargo.toml && echo yes || echo no`);
  if (cargo.stdout.trim() === 'yes') return 'cargo build';
  // Go
  const gomod = await exec(`cd ${shq(cwd)} && test -f go.mod && echo yes || echo no`);
  if (gomod.stdout.trim() === 'yes') return 'go build ./...';
  // CMake
  const cmake = await exec(`cd ${shq(cwd)} && test -f CMakeLists.txt && echo yes || echo no`);
  if (cmake.stdout.trim() === 'yes') return 'cmake --build .';
  return null;
}

/** Extract compiler error lines (file:line:col: error: ...) from build output. */
export function extractBuildErrors(stdout: string): string[] {
  const errors: string[] = [];
  // GCC/Clang/Cargo/tsc/rustc: "path:line: error: ..." or "error[Exxxx]:"
  const patterns = [
    /^(.+?:\d+(?::\d+)?:\s*error:.*)$/i,
    /^error(\[[a-z0-9]+\])?:\s*.+$/i,
    /^(.+\.rs:\d+:\d+)$/i, // rustc locations
    /^(  --> .+:\d+:\d+)$/i, // rustc arrow locations
    /^(.+\.ts\(\d+,\d+\):\s*error.+)$/i, // tsc
    /^(FAILED.+)$/i,
  ];
  for (const line of stdout.split('\n')) {
    for (const re of patterns) {
      if (re.test(line)) {
        errors.push(line.trim());
        break;
      }
    }
  }
  // Dedup while preserving order.
  return Array.from(new Set(errors));
}

/* ============================================================================
 * tree — gitignore-aware directory tree for fast repo orientation.
 *
 * The first thing an agent does in a new repo is figure out the layout. `ls`
 * one dir at a time is slow; `find .` drowns in node_modules/.git noise. This
 * tool returns a clean, depth-limited, ignore-aware tree in one call.
 * ==========================================================================*/

export function makeTreeTool(exec: ExecFn): Tool {
  return {
    name: 'tree',
    description:
      'Show a directory tree of the project, depth-limited and excluding ' +
      'node_modules/.git/target/build/dist. Use this ONCE at the start to ' +
      'orient in an unfamiliar repo instead of many ls calls.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory (default current).' },
        depth: { type: 'number', description: 'Max depth (default 3).' },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const path = typeof r.path === 'string' && r.path ? r.path : '.';
      const depth = typeof r.depth === 'number' && r.depth > 0 ? Math.min(r.depth, 5) : 3;
      // Use `find` with prune of common heavy dirs, then format. Fallback to a
      // manual walk if find isn't available (rare).
      const excludeDirs = ['node_modules', '.git', 'target', 'build', 'dist', '.next', '__pycache__', '.venv', 'venv'];
      const pruneExpr = excludeDirs.map((d) => `-name ${shq(d)} -prune`).join(' -o ');
      const res = await exec(
        `cd ${shq(path)} && find . \\( ${pruneExpr} \\) -o -type f -print 2>/dev/null | head -200 | sort`,
        15_000,
      );
      if (res.code !== 0 && !res.stdout.trim()) {
        return { content: `Error generating tree: ${res.stdout.trim() || '(empty)'}`, isError: true };
      }
      const files = res.stdout.trim().split('\n').filter(Boolean);
      if (files.length === 0) return { content: '(empty directory)', isError: false };
      // Format as an indented tree by path depth, truncated to depth.
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        const parts = f.replace(/^\.\//, '').split('/');
        if (parts.length > depth) continue;
        // Add directory entries implied by the path.
        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join('/');
          if (!seen.has(dirPath + '/')) {
            seen.add(dirPath + '/');
            lines.push('  '.repeat(i - 1) + parts[i - 1] + '/');
          }
        }
        if (!seen.has(f)) {
          seen.add(f);
          lines.push('  '.repeat(parts.length - 1) + parts[parts.length - 1]);
        }
      }
      const capped = lines.slice(0, 200);
      const trailer = lines.length > 200 ? `\n\n[…truncated at 200 entries…]` : '';
      return { content: capped.join('\n') + trailer, isError: false };
    },
  };
}

/* ============================================================================
 * http_request — structured HTTP client replacing hand-rolled curl.
 *
 * Agents that need to hit an API or download a URL hand-roll `curl -s ... | jq`,
 * which breaks on headers, JSON bodies, and error status codes. This tool
 * returns structured {status, headers, body} and handles JSON bodies natively.
 * ==========================================================================*/

export function makeHttpRequestTool(exec: ExecFn): Tool {
  return {
    name: 'http_request',
    description:
      'Make an HTTP request and return STRUCTURED output: status code, response ' +
      'headers, and body (auto-parsed as JSON if Content-Type is JSON). Use this ' +
      'instead of hand-rolling curl + jq. Supports GET/POST/PUT/DELETE, custom ' +
      'headers, and a JSON body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Request headers as key-value pairs.' },
        body: { type: 'string', description: 'Request body (for POST/PUT).' },
      },
      required: ['url'],
    },
    execute: async (input): Promise<ToolResult> => {
      const r = input as Record<string, unknown>;
      const url = r.url;
      if (typeof url !== 'string' || !url) {
        return { content: "Error: 'url' is required.", isError: true };
      }
      const method = typeof r.method === 'string' && r.method ? r.method.toUpperCase() : 'GET';
      const headers = (r.headers && typeof r.headers === 'object') ? r.headers as Record<string, string> : {};
      const body = typeof r.body === 'string' ? r.body : null;

      // Build the request via Bun's fetch in an inline script so it works in
      // both the local (bun) and container (bun) environments. We write the
      // result as JSON to stdout.
      const script = `const r = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(headers)}${body ? `,
        body: ${JSON.stringify(body)}` : ''},
      });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      process.stdout.write(JSON.stringify({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: parsed }));`;
      const res = await exec(`bun -e '${script.replace(/'/g, "'\\''")}'`, 30_000);
      if (res.code !== 0) {
        return { content: `HTTP request failed: ${tailOutput(res.stdout + res.stdout, 10)}`, isError: true };
      }
      try {
        const result = JSON.parse(res.stdout);
        const ok = typeof result.status === 'number' && result.status >= 200 && result.status < 300;
        const lines = [`HTTP ${result.status} ${ok ? '✅' : '⚠️'}`];
        const ct = result.headers?.['content-type'] || result.headers?.['Content-Type'] || '';
        if (ct.includes('application/json') && typeof result.body === 'object') {
          lines.push(JSON.stringify(result.body, null, 2));
        } else {
          lines.push(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
        }
        return { content: lines.join('\n'), isError: !ok };
      } catch {
        return { content: res.stdout, isError: false };
      }
    },
  };
}

/** Return the last N lines of an output string. */
function tailOutput(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/* ============================================================================
 * Helpers
 * ==========================================================================*/

/** Single-quote a string for safe shell interpolation. */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/**
 * Build the full specialist-tool set bound to a given executor. The bench
 * harness calls this with its docker exec; the TUI calls it with localExec.
 */
export function makeSpecialistTools(exec: ExecFn): Tool[] {
  return [
    makeLatexCheckTool(exec),
    makeLatexFixBoxesTool(exec),
    makeRunTestsTool(exec),
    makeInspectEnvTool(exec),
    makeInstallDepsTool(exec),
    makeBuildTool(exec),
    makeHexDumpTool(exec),
    makeDiffTool(exec),
    makeTreeTool(exec),
    makeHttpRequestTool(exec),
  ];
}

/** Specialist tools bound to the LOCAL shell — for the TUI agent. */
export function localSpecialistTools(): Tool[] {
  return makeSpecialistTools(localExec);
}
