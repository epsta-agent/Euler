/**
 * Specialist tools unit tests.
 *
 * The value of these tools is in their PARSERS — turning noisy command output
 * (LaTeX logs, pytest output) into structured facts the model can act on. We
 * test the parsers directly against realistic fixtures captured from the
 * terminal-bench failure logs, plus the tool end-to-end against a fake exec.
 */

import { describe, it, expect } from 'bun:test';
import {
  parseBoxWarnings,
  parseTestSummary,
  extractBuildErrors,
  makeLatexCheckTool,
  makeLatexFixBoxesTool,
  makeRunTestsTool,
  makeInspectEnvTool,
  makeInstallDepsTool,
  makeBuildTool,
  makeHexDumpTool,
  makeDiffTool,
  makeTreeTool,
  makeHttpRequestTool,
  type ExecFn,
} from '../../src/agent/tool/specialist';

// A fake exec that returns scripted output per command-substring match. Lets us
// drive a tool end-to-end without docker or a real shell.
function fakeExec(scripts: Array<[match: RegExp, out: string, code?: number]>): ExecFn {
  return async (command: string) => {
    for (const [re, out, code] of scripts) {
      if (re.test(command)) return { stdout: out, code: code ?? 0 };
    }
    return { stdout: '', code: 0 };
  };
}

describe('latex_check — parseBoxWarnings', () => {
  it('extracts overfull hbox warnings with width and offending text', () => {
    // Captured from the actual overfull-hbox bench failure log.
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '(./main.tex',
      'Overfull \\hbox (3.76862pt too wide) in paragraph at lines 7--8',
      '\\OT1/cmr/m/n/10 man-tic readi-ness such as I have never found',
      '[2] [3] [4]) [5]',
    ].join('\n');
    const warnings = parseBoxWarnings(log);
    expect(warnings.length).toBe(1);
    expect(warnings[0].kind).toBe('Overfull');
    expect(warnings[0].box).toBe('hbox');
    expect(warnings[0].amount).toBe('3.76862pt');
    expect(warnings[0].too).toBe('wide');
    expect(warnings[0].lines).toBe('7--8');
    // The offending text must be extracted — this is the whole point: the
    // agent in the bench run never identified "man-tic readi-ness".
    expect(warnings[0].text.toLowerCase()).toContain('man-tic');
  });

  it('extracts underfull vbox warnings', () => {
    const log = 'Underfull \\vbox (badness 1234) detected at line 42\nsome text';
    const warnings = parseBoxWarnings(log);
    expect(warnings.length).toBe(1);
    expect(warnings[0].kind).toBe('Underfull');
    expect(warnings[0].box).toBe('vbox');
    expect(warnings[0].lines).toBe('42');
  });

  it('handles multiple warnings', () => {
    const log = [
      'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2',
      'word one',
      'Overfull \\hbox (2.0pt too wide) in paragraph at lines 5--6',
      'word two',
    ].join('\n');
    const warnings = parseBoxWarnings(log);
    expect(warnings.length).toBe(2);
    expect(warnings[0].lines).toBe('1--2');
    expect(warnings[1].lines).toBe('5--6');
  });

  it('returns empty for a clean log', () => {
    expect(parseBoxWarnings('no warnings here\njust normal output')).toEqual([]);
  });
});

describe('latex_check — end to end', () => {
  it('reports a clean compile with no warnings', async () => {
    const exec = fakeExec([
      [/pdflatex/, 'Output written on main.pdf', 0],
      [/cat \*\.log/, 'clean log, no warnings', 0],
    ]);
    const tool = makeLatexCheckTool(exec);
    const result = await tool.execute({ file: 'main.tex' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No overfull/underfull box warnings');
  });

  it('reports the offending text when there is an overfull box', async () => {
    const exec = fakeExec([
      [/pdflatex/, 'Output written on main.pdf', 0],
      [
        /cat \*\.log/,
        'Overfull \\hbox (3.76862pt too wide) in paragraph at lines 7--8\n' +
          '\\OT1/cmr/m/n/10 man-tic readi-ness such as I have never found',
        0,
      ],
    ]);
    const tool = makeLatexCheckTool(exec);
    const result = await tool.execute({ file: 'main.tex' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('3.76862pt');
    expect(result.content).toContain('lines 7--8');
    expect(result.content.toLowerCase()).toContain('man-tic');
  });

  it('surfaces compilation errors distinctly from box warnings', async () => {
    const exec = fakeExec([
      [/pdflatex/, '! LaTeX Error: File `foo.sty\' not found.', 1],
      [/cat \*\.log/, '', 1],
    ]);
    const tool = makeLatexCheckTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Compilation FAILED');
  });
});

describe('run_tests — parseTestSummary', () => {
  it('parses pytest PASSED/FAILED lines into per-test results', () => {
    // Captured shape from the bench pytest output.
    const out = [
      'PASSED ../tests/test_outputs.py::test_required_files_exist',
      'PASSED ../tests/test_outputs.py::test_data_files_exist',
      'FAILED ../tests/test_outputs.py::test_no_overfull_hboxes',
      '========================= 2 passed, 1 failed in 0.03s =========================',
    ].join('\n');
    const summary = parseTestSummary(out, 'pytest -v');
    expect(summary).toContain('2 passed, 1 failed');
    expect(summary).toContain('❌ test_no_overfull_hboxes');
    expect(summary).toContain('✅ test_required_files_exist');
  });

  it('handles all-pass', () => {
    const out = 'PASSED ::test_a\nPASSED ::test_b\n2 passed';
    const summary = parseTestSummary(out, 'pytest');
    expect(summary).toContain('2 passed, 0 failed');
    expect(summary).not.toContain('❌');
  });

  it('handles all-fail', () => {
    const out = 'FAILED ::test_a\nFAILED ::test_b\n2 failed';
    const summary = parseTestSummary(out, 'pytest');
    expect(summary).toContain('0 passed, 2 failed');
  });

  it('falls back to raw tail when output is unparseable', () => {
    const summary = parseTestSummary('weird tool output\nno tests here', 'weirdcmd');
    expect(summary).toContain('weirdcmd');
    expect(summary).toContain('weird tool output');
  });
});

describe('run_tests — end to end', () => {
  it('auto-detects terminal-bench /tests/test.sh when present', async () => {
    const exec = fakeExec([
      [/test -f \/tests\/test\.sh/, 'yes', 0],
      [/bash \/tests\/test\.sh/, 'PASSED ::test_a\n1 passed', 0],
    ]);
    const tool = makeRunTestsTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('1 passed');
  });

  it('returns error when no test command can be detected and none given', async () => {
    const exec = fakeExec([
      [/test -f \/tests/, 'no', 0],
      [/test -f/, 'no', 0],
    ]);
    const tool = makeRunTestsTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('auto-detect');
  });

  it('runs an explicit command', async () => {
    const exec = fakeExec([
      [/cargo test/, 'test result: FAILED. 1 passed; 1 failed', 1],
    ]);
    const tool = makeRunTestsTool(exec);
    const result = await tool.execute({ command: 'cargo test' });
    expect(result.isError).toBe(true);
  });
});

describe('inspect_env — end to end', () => {
  it('returns the installed tools list', async () => {
    const exec = fakeExec([
      [/command -v/, 'python3: Python 3.13.14\nnode: v20.0.0\ngcc: gcc 13.0', 0],
      [/uname/, 'Linux arm64', 0],
    ]);
    const tool = makeInspectEnvTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Python 3.13');
    expect(result.content).toContain('Platform: Linux arm64');
  });
});

describe('hex_dump — end to end', () => {
  it('requires a path', async () => {
    const tool = makeHexDumpTool(fakeExec([]));
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it('returns od output', async () => {
    const exec = fakeExec([[/^od /, '0000000 41 42 43  >ABC<\n0000003', 0]]);
    const tool = makeHexDumpTool(exec);
    const result = await tool.execute({ path: '/app/data.dat', bytes: 16 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('ABC');
  });
});

describe('diff_files — end to end', () => {
  it('requires file a', async () => {
    const tool = makeDiffTool(fakeExec([]));
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });

  it('returns "(no differences)" when files match', async () => {
    const exec = fakeExec([[/diff -u/, '', 0]]);
    const tool = makeDiffTool(exec);
    const result = await tool.execute({ a: 'f1.txt', b: 'f2.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('no differences');
  });

  it('returns the unified diff when files differ', async () => {
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new';
    const exec = fakeExec([[/diff -u/, diff, 1]]);
    const tool = makeDiffTool(exec);
    const result = await tool.execute({ a: 'f1.txt', b: 'f2.txt' });
    expect(result.isError).toBe(false); // exit 1 from diff = differences, not error
    expect(result.content).toContain('-old');
    expect(result.content).toContain('+new');
  });

  it('uses git diff HEAD when only one file given', async () => {
    const diff = 'diff --git a/f b/f\n-old\n+new';
    const exec = fakeExec([[/git diff/, diff, 1]]);
    const tool = makeDiffTool(exec);
    const result = await tool.execute({ a: 'f.txt' });
    expect(result.content).toContain('+new');
  });
});

describe('latex_fix_boxes — end to end', () => {
  const DOC = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\input{input.tex}',
    '\\end{document}',
  ].join('\n');

  it('injects emergencystretch after \\begin{document} and reports clean compile', async () => {
    let writtenContent = '';
    const exec: ExecFn = async (command: string) => {
      if (/^cat /.test(command) && !command.includes('patch') && !command.includes('main.tex') === false && !command.includes('<<')) {
        // read of main.tex
        return { stdout: DOC, code: 0 };
      }
      if (command.includes('cat >')) {
        // capture the heredoc write
        const m = command.match(/<<'EULER_TEX_PATCH'\n([\s\S]*?)EULER_TEX_PATCH/);
        if (m) writtenContent = m[1];
        return { stdout: '', code: 0 };
      }
      if (command.includes('pdflatex')) return { stdout: 'ok', code: 0 };
      if (command.includes('cat *.log')) return { stdout: 'clean log', code: 0 };
      return { stdout: '', code: 0 };
    };
    const tool = makeLatexFixBoxesTool(exec);
    const result = await tool.execute({ file: 'main.tex' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('NO overfull/underfull');
    // The patch must have been injected.
    expect(writtenContent).toContain('emergencystretch');
    expect(writtenContent).toContain('\\begin{document}');
  });

  it('is idempotent — does not re-inject if the mitigation is already present', async () => {
    const alreadyPatched = DOC.replace('\\begin{document}', '\\begin{document}\n\\setlength{\\emergencystretch}{1em}');
    let wrote = false;
    const exec: ExecFn = async (command: string) => {
      if (command.includes('cat >')) { wrote = true; return { stdout: '', code: 0 }; }
      if (command.includes('pdflatex')) return { stdout: 'ok', code: 0 };
      if (command.includes('cat *.log')) return { stdout: 'clean', code: 0 };
      return { stdout: alreadyPatched, code: 0 };
    };
    const tool = makeLatexFixBoxesTool(exec);
    const result = await tool.execute({});
    expect(result.content).toContain('already patched');
    expect(wrote).toBe(false);
  });

  it('reports remaining warnings when the fix is insufficient', async () => {
    const exec: ExecFn = async (command: string) => {
      if (command.includes('cat >')) return { stdout: '', code: 0 };
      if (command.includes('pdflatex')) return { stdout: 'ok', code: 0 };
      if (command.includes('cat *.log')) {
        return {
          stdout: 'Overfull \\hbox (5.0pt too wide) in paragraph at lines 3--4\nstill bad text here',
          code: 0,
        };
      }
      return { stdout: DOC, code: 0 };
    };
    const tool = makeLatexFixBoxesTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('still remain');
    expect(result.content).toContain('5.0pt');
  });

  it('errors when no injection point is found', async () => {
    const exec: ExecFn = async (command: string) => {
      if (command.includes('cat >')) return { stdout: '', code: 0 };
      // A .tex with neither \begin{document} nor \documentclass
      return { stdout: 'just some plain text with no latex structure', code: 0 };
    };
    const tool = makeLatexFixBoxesTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('could not find');
  });
});

describe('latex_check — cross-tool steering', () => {
  it('recommends calling latex_fix_boxes (not hand-editing) when warnings exist', async () => {
    const exec = fakeExec([
      [/pdflatex/, 'ok', 0],
      [
        /cat \*\.log/,
        'Overfull \\hbox (3.76862pt too wide) in paragraph at lines 7--8\n\\OT1/cmr/m/n/10 man-tic',
        0,
      ],
    ]);
    const tool = makeLatexCheckTool(exec);
    const result = await tool.execute({ file: 'main.tex' });
    // The steering is the fix for the overfull-hbox whack-a-mole: the agent
    // must be pointed at latex_fix_boxes by name, not told to hand-edit.
    expect(result.content).toContain('latex_fix_boxes');
    expect(result.content).not.toContain('\\sloppy / \\hbadness');
  });
});

describe('extractBuildErrors', () => {
  it('extracts gcc/clang error lines', () => {
    const out = [
      'main.c:10:5: error: use of undeclared identifier foo',
      'main.c:11:1: warning: unused variable',
      'main.c:12:3: error: expected \';\' after expression',
      'Linking...',
    ].join('\n');
    const errors = extractBuildErrors(out);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('undeclared identifier');
    expect(errors[1]).toContain('expected');
  });

  it('extracts rustc error[Exxxx] lines', () => {
    const out = [
      'error[E0425]: cannot find value `x` in this scope',
      '  --> src/main.rs:5:13',
      '   |',
      '5 |     println!("{}", x);',
    ].join('\n');
    const errors = extractBuildErrors(out);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes('E0425'))).toBe(true);
    expect(errors.some((e) => e.includes('main.rs:5:13'))).toBe(true);
  });

  it('extracts FAILED lines', () => {
    const out = 'FAILED tests/test_a.py::test_foo\nFAILED tests/test_b.py::test_bar';
    const errors = extractBuildErrors(out);
    expect(errors.length).toBe(2);
  });

  it('returns empty for clean output', () => {
    expect(extractBuildErrors('all good\nno problems here')).toEqual([]);
  });

  it('dedupes repeated errors', () => {
    const out = 'main.c:1:1: error: x\nmain.c:1:1: error: x';
    expect(extractBuildErrors(out).length).toBe(1);
  });
});

describe('install_deps — end to end', () => {
  it('auto-detects npm from package.json', async () => {
    const exec = fakeExec([
      [/package\.json/, 'yes', 0],
      [/npm install/, 'added 42 packages', 0],
      // package.json path also checks for bun/yarn
      [/command -v bun/, 'no', 0],
      [/command -v yarn/, 'no', 0],
    ]);
    const tool = makeInstallDepsTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('npm install');
    expect(result.content).toContain('installed successfully');
  });

  it('prefers bun when available (faster than npm)', async () => {
    const exec = fakeExec([
      [/package\.json/, 'yes', 0],
      [/command -v bun/, 'yes', 0],
      [/bun install/, 'Resolved, installed', 0],
    ]);
    const tool = makeInstallDepsTool(exec);
    const result = await tool.execute({});
    expect(result.content).toContain('bun install');
  });

  it('surfaces failure output tail on non-zero exit', async () => {
    const exec = fakeExec([
      [/test -f 'requirements\.txt'/, 'yes', 0],
      [/pip install/, 'ERROR: Could not find a version\nHINT: check spelling', 1],
    ]);
    const tool = makeInstallDepsTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not find a version');
  });

  it('errors when no manifest found and no manager forced', async () => {
    const exec = fakeExec([[/test -f/, 'no', 0]]);
    const tool = makeInstallDepsTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No dependency manifest');
  });
});

describe('build — end to end', () => {
  it('reports success on exit 0', async () => {
    const exec = fakeExec([
      [/Makefile/, 'yes', 0],
      [/\bmake\b/, 'gcc -c main.c\nLinking done', 0],
    ]);
    const tool = makeBuildTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Build succeeded');
  });

  it('extracts errors and shows output tail on failure', async () => {
    const exec = fakeExec([
      [/Makefile/, 'yes', 0],
      [/\bmake\b/, 'main.c:5:1: error: missing semicolon\nmake: *** [main.o] Error 1', 2],
    ]);
    const tool = makeBuildTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Build FAILED');
    expect(result.content).toContain('missing semicolon');
  });

  it('runs an explicit command', async () => {
    const exec = fakeExec([[/tsc --build/, '', 0]]);
    const tool = makeBuildTool(exec);
    const result = await tool.execute({ command: 'tsc --build' });
    expect(result.isError).toBe(false);
  });
});

describe('tree — end to end', () => {
  it('formats a find output into an indented tree', async () => {
    const exec = fakeExec([
      [
        /find/,
        ['./src/main.ts', './src/util.ts', './README.md', './package.json'].join('\n'),
        0,
      ],
    ]);
    const tool = makeTreeTool(exec);
    const result = await tool.execute({});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('src/');
    expect(result.content).toContain('main.ts');
    expect(result.content).toContain('README.md');
  });

  it('handles empty directory', async () => {
    const exec = fakeExec([[/find/, '', 0]]);
    const tool = makeTreeTool(exec);
    const result = await tool.execute({});
    expect(result.content).toContain('empty');
  });
});

describe('http_request — end to end', () => {
  it('requires a url', async () => {
    const tool = makeHttpRequestTool(fakeExec([]));
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it('parses a 200 JSON response', async () => {
    // The tool runs `bun -e '<script>'`; we fake the exec to return the JSON
    // the script would produce.
    const fakeResponse = JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { ok: true, message: 'hello' },
    });
    const exec = fakeExec([[/bun -e/, fakeResponse, 0]]);
    const tool = makeHttpRequestTool(exec);
    const result = await tool.execute({ url: 'https://example.com/api' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('HTTP 200');
    expect(result.content).toContain('hello');
  });

  it('marks non-2xx as error', async () => {
    const fakeResponse = JSON.stringify({
      status: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'Not Found',
    });
    const exec = fakeExec([[/bun -e/, fakeResponse, 0]]);
    const tool = makeHttpRequestTool(exec);
    const result = await tool.execute({ url: 'https://example.com/missing' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('HTTP 404');
  });
});
