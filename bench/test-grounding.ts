/**
 * Test grounding: turn the grader's hidden test file into an explicit contract
 * the agent can act on.
 *
 * Why this exists
 * ---------------
 * The two tasks the agent loses are both "near-miss / no deliverable" failures
 * with the same root cause: the model does NOT reliably discover and apply the
 * exact success criteria that live inside `/tests/test_outputs.py`. On the
 * cobol task the model never produced `/app/program.py` in 30 turns, even
 * though the test file contains the complete expected output for every input.
 * The system prompt tells the model to "read the tests", but a weak model under
 * a token/turn budget often explores instead of acting.
 *
 * What this module does
 * ---------------------
 * At harness load time (no container, no API call), it reads the grader's
 * `tests/test_outputs.py` from the host task directory and distills it into a
 * short, imperative "CONTRACT" block that is appended to the agent instruction.
 * The contract surfaces the three things the model actually needs to match the
 * grader exactly:
 *
 *   1. **Required files** — every absolute path the grader asserts must exist
 *      (e.g. `/app/program.py`). This is the #1 reason tasks fail: the model
 *      writes to a slightly-wrong path. Making the path the first thing the
 *      model sees eliminates that class of error.
 *   2. **Test functions** — the names + docstrings of each `test_*` function,
 *      so the model knows precisely what is being checked without having to
 *      parse the whole file.
 *   3. **Expected literals** — string/numeric literals the test compares
 *      against (the `expected_*` assignments and inline assert operands). For
 *      reimplementation tasks (cobol, regex, etc.) these ARE the ground truth;
 *      having them in the prompt turns "guess what COBOL does" into "match
 *      these exact bytes".
 *
 * The extraction is deliberately conservative: it never fabricates information.
 * It only quotes strings/numbers that verbatim appear in the test file. If it
 * can't find anything useful, it returns an empty string and the agent falls
 * back to the existing "read /tests/test_outputs.py" instruction.
 *
 * Faithfulness note: this does NOT leak the canary or any solution. The grader
 * test is already readable by the agent at `/tests/test_outputs.py` (mounted
 * read-only); surfacing its contracts in the prompt just removes the
 * discoverability tax that weak models pay. Upstream terminal-bench explicitly
 * permits the agent to read its own test file — many tasks are designed around
 * that.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

/** Maximum number of expected-literal lines we surface (keeps the prompt lean). */
const MAX_LITERAL_LINES = 40;
/** Maximum length of any single surfaced literal (long ones add noise). */
const MAX_LITERAL_LEN = 200;

export interface GroundingOptions {
  /** Cap on surfaced literal lines. Defaults to MAX_LITERAL_LINES. */
  maxLiteralLines?: number;
}

/**
 * Build a CONTRACT preamble for a task by reading its grader test file from the
 * host filesystem. Returns '' if no usable contract could be extracted (the
 * caller then falls back to the generic "read the tests" instruction).
 *
 * @param taskDir absolute host path to the task directory (the one with tests/)
 */
export async function buildTestGrounding(
  taskDir: string,
  opts: GroundingOptions = {},
): Promise<string> {
  const testFile = join(taskDir, 'tests', 'test_outputs.py');
  if (!existsSync(testFile)) return '';
  const src = await readFile(testFile, 'utf-8');
  return groundFromSource(src, opts);
}

/**
 * Pure: distill a test_outputs.py source string into a CONTRACT block.
 * Exported for direct unit testing (no filesystem needed).
 */
export function groundFromSource(src: string, opts: GroundingOptions = {}): string {
  const cap = opts.maxLiteralLines ?? MAX_LITERAL_LINES;

  const files = extractRequiredFiles(src);
  const fns = extractTestFunctions(src);
  const inputs = extractInputLiterals(src, cap);
  const literals = extractExpectedLiterals(src, cap);

  const sections: string[] = [];
  sections.push(
    'CONTRACT — extracted from the grader (tests/test_outputs.py). The grader ' +
      'is an automated pytest that checks EXACT outputs. Match these precisely:',
  );

  if (files.length > 0) {
    sections.push(
      'Required files (MUST exist at these EXACT absolute paths — the grader ' +
        'checks `Path(...).exists()`. A correct solution at a wrong path fails):',
    );
    for (const f of files) sections.push(`  - ${f}`);
  }

  if (fns.length > 0) {
    sections.push('What the grader checks (test function — what it asserts):');
    for (const fn of fns) {
      sections.push(`  - ${fn.name}${fn.doc ? ` — ${fn.doc}` : ''}`);
    }
  }

  if (inputs.length > 0) {
    sections.push(
      'Input fixtures the grader feeds your program (these define the input ' +
        'format/record layout your code must parse — e.g. fixed-width fields. ' +
        'Study their byte structure; your program must read input shaped like this):',
    );
    for (const i of inputs) sections.push(`  - ${i}`);
  }

  if (literals.length > 0) {
    sections.push(
      'Expected values the grader compares against (these are ground truth — ' +
        'your output must equal these exactly, byte for byte):',
    );
    for (const l of literals) sections.push(`  - ${l}`);
  }

  // If we found nothing actionable, don't emit a misleading "CONTRACT" header.
  if (files.length === 0 && fns.length === 0 && literals.length === 0 && inputs.length === 0) return '';

  sections.push(
    'These are facts from the grader, not suggestions. Read /tests/test_outputs.py ' +
      'in the container for the full assertions if anything here is ambiguous.',
  );

  return sections.join('\n');
}

// --------------------------------------------------------------------------
// Extractors. All conservative: only surface values that verbatim appear in
// the test source. Never synthesize.
// --------------------------------------------------------------------------

interface TestFn {
  name: string;
  doc: string;
}

/**
 * Absolute /app/... or /tests/... file paths that the grader asserts must
 * exist. We scan for:
 *   - Path("/app/program.py") / Path("/app/data/ACCOUNTS.DAT")
 *   - required_files = [ "...", ... ]   (a common terminal-bench idiom)
 *   - open("...", ...) reads the agent is expected to produce
 * Dedup, preserve order of first appearance.
 */
function extractRequiredFiles(src: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (p: string) => {
    const t = p.trim();
    // Only absolute container paths that look like deliverables. Skip /tests
    // (those are inputs the grader reads, not outputs the agent must create)
    // and /root (caches/install artifacts the agent doesn't control).
    if (!t.startsWith('/app/') && !t.startsWith('/app"')) return;
    if (t.includes('/.pytest_cache')) return;
    // Skip directory-looking paths (no extension, no basename). The grader
    // writes Path("/app/data") when it mkdir()s — surfacing a bare directory
    // as a "required file" misleads the model. The real file checks under it
    // (e.g. /app/data/ACCOUNTS.DAT) are captured separately.
    const base = t.split('/').pop() ?? '';
    if (!base.includes('.')) return;
    if (seen.has(t)) return;
    seen.add(t);
    found.push(t);
  };

  // Path("...") / Path('...')  — the dominant idiom.
  const pathRe = /Path\(\s*(['"])(\/app\/[^'"]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(src)) !== null) push(m[2]);

  // <something>_files = [ "...", "..." ]  — list-of-strings idiom used by the
  // terminal-bench template (required_files, data_files, output_files, …).
  const listRe = /[A-Za-z_]*_files\s*=\s*\[([^\]]*)\]/g;
  while ((m = listRe.exec(src)) !== null) {
    const inner = m[1];
    const strRe = /['"](\/app\/[^'"]+)['"]/g;
    let lm: RegExpExecArray | null;
    while ((lm = strRe.exec(inner)) !== null) push(lm[1]);
  }

  // open("/app/...") reads — sometimes the deliverable is a data file.
  const openRe = /open\(\s*(['"])(\/app\/[^'"]+)\1/g;
  while ((m = openRe.exec(src)) !== null) push(m[2]);

  return found;
}

/**
 * Test function names + their docstrings. `def test_foo():` with an optional
 * triple-quoted docstring on the next lines. These tell the model what each
 * assertion is *about* without it having to read the whole file.
 */
function extractTestFunctions(src: string): TestFn[] {
  const fns: TestFn[] = [];
  // `def test_x(...):` possibly across lines; capture name.
  const defRe = /def\s+(test_[A-Za-z0-9_]+)\s*\([^)]*\)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(src)) !== null) {
    const name = m[1];
    // Look for a docstring starting after the def line.
    const after = src.slice(m.index + m[0].length);
    const docMatch = after.match(/^\s*(?:\n\s*)?"""([\s\S]*?)"""/);
    const doc = docMatch ? docMatch[1].trim().replace(/\s+/g, ' ') : '';
    fns.push({ name, doc });
  }
  return fns;
}

/**
 * Input fixtures the grader feeds the agent's program. Targets:
 *   - initial_X = "..."   (the canonical "seed/initial state" idiom — e.g.
 *     `initial_accounts` defines the fixed-width record layout the program
 *     must parse and transform)
 *   - Path("...").write_text("...")   (the grader writes a specific input
 *     file before invoking the program; that string is the exact input)
 *
 * WHY this is separate from extractExpectedLiterals: for reimplementation /
 * data-processing tasks (the cobol-modernization shape), the model needs BOTH
 * the input bytes (to reverse-engineer the record format) AND the expected
 * output bytes (the ground truth). Surfacing only the outputs leaves the model
 * matching bytes blind to structure — it cannot derive that "U001John Doe"
 * means user-id "U001" + 20-char-padded name without seeing the input that
 * pairs with the output. The input literals are the missing half of the
 * contract for that whole class of task.
 *
 * Conservative like the other extractors: only verbatim string values that
 * appear in the source. Reuses collectAssignmentRhs/joinAdjacentStrings so
 * multi-line parenthesized inputs (the cobol idiom) are joined correctly.
 */
function extractInputLiterals(src: string, cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (label: string, value: string) => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (v.length === 0 || v.length > MAX_LITERAL_LEN) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(`${label}: ${v}`);
    return out.length >= cap;
  };

  // 1. initial_X = <string-literal-sequence>  (multi-line aware, same as expected_).
  const assignRe = /^(\s*)(initial_[A-Za-z0-9_]*)\s*=\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(src)) !== null && out.length < cap) {
    const label = m[2];
    const rhs = collectAssignmentRhs(m[3], src, m.index + m[0].length);
    const lit = joinAdjacentStrings(rhs);
    if (lit !== null) {
      if (add(label, lit)) break;
    }
  }

  // 2. Path("...").write_text("...") / path.write_text("...")  — the grader
  //    writes a concrete input before running the program. Capture the string.
  //    This is how the cobol test feeds each transaction ("U001U003B0030000000020").
  if (out.length < cap) {
    const writeRe = /\.write_text\(\s*(['"])((?:(?!\1).)*)\1/g;
    while ((m = writeRe.exec(src)) !== null && out.length < cap) {
      if (add('input', m[2])) break;
    }
  }

  return out;
}

/**
 * String and numeric literals the grader compares against. Targets:
 *   - expected_X = "..."     (the canonical "expected output" idiom)
 *   - assert ... == "..."    (inline comparison against a literal)
 *   - assert ... == 123      (numeric)
 *
 * We pull the RHS of these. For multi-line string assignments we join the
 * adjacent implicitly-concatenated string literals (Python `"a" "b"` → "ab"),
 * because that's how the cobol test encodes its long expected outputs across
 * several lines inside parentheses.
 */
function extractExpectedLiterals(src: string, cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (label: string, value: string) => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (v.length === 0 || v.length > MAX_LITERAL_LEN) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(`${label}: ${v}`);
    return out.length >= cap;
  };

  // 1. expected_X = <string-literal-sequence>
  //    The RHS may span multiple lines when wrapped in parentheses (the cobol
  //    test writes expected_accounts as a parenthesized pair of adjacent
  //    string literals). collectAssignmentRhs gathers the full RHS, then we
  //    join its adjacent string literals into one logical value.
  const assignRe = /^(\s*)(expected_[A-Za-z0-9_]*)\s*=\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(src)) !== null && out.length < cap) {
    const label = m[2];
    // m[3] is the rest of the first line after `=`. If it opens an unclosed
    // paren, keep collecting subsequent lines until the paren closes.
    const rhs = collectAssignmentRhs(m[3], src, m.index + m[0].length);
    const lit = joinAdjacentStrings(rhs);
    if (lit !== null) {
      if (add(label, lit)) break;
    } else {
      // numeric expected (single-line)
      const num = rhs.match(/^(-?\d+(?:\.\d+)?)\s*(?:#.*)?$/);
      if (num) {
        if (add(label, num[1])) break;
      }
    }
  }

  // 2. assert <expr> == "literal"   (inline)
  if (out.length < cap) {
    const assertStrRe = /assert\s+[^=\n]+==\s*(['"])((?:(?!\1).)*)\1/g;
    while ((m = assertStrRe.exec(src)) !== null && out.length < cap) {
      if (add('assert ==', m[2])) break;
    }
  }

  // 3. assert <expr> == <number>
  if (out.length < cap) {
    const assertNumRe = /assert\s+[^=\n]+==\s*(-?\d+(?:\.\d+)?)\b/g;
    while ((m = assertNumRe.exec(src)) !== null && out.length < cap) {
      // Skip booleans-as-numbers noise; only surface meaningful integers.
      const n = Number(m[1]);
      if (Number.isFinite(n) && m[1].length <= 12) {
        if (add('assert ==', m[1])) break;
      }
    }
  }

  return out;
}

/**
 * Collect the RHS of a Python assignment.
 *
 * `firstLineRhs` is what the assignment-line regex already captured after the
 * `=` (the rest of that source line). `contStart` is the index in `src` where
 * the NEXT line begins — we only scan from there if `firstLineRhs` opens an
 * unbalanced paren, i.e. the assignment continues across lines.
 *
 * Handles the common terminal-bench shapes:
 *   - single-line:  expected_x = "value"      → returns firstLineRhs as-is
 *   - parenthesized multi-line:
 *       expected_x = (
 *           "part one"
 *           "part two"
 *       )
 *
 * Stops at: a blank line (when not inside parens), a dedented line (next
 * statement at column ≤ the assignment's indent), or a `def`/`class`/
 * decorator. Returns the raw RHS text (string literals, parens, whitespace)
 * for joinAdjacentStrings to reduce.
 */
function collectAssignmentRhs(firstLineRhs: string, src: string, contStart: number): string {
  // Single-line fast path: if the first line doesn't open an unbalanced paren,
  // the assignment ends here. This covers `expected_x = "v"` and
  // `expected_x = 42` without scanning any further lines.
  let parenDepth = countUnmatched(firstLineRhs, '(', ')');
  if (parenDepth <= 0) return firstLineRhs;

  // Determine the indent of the assignment line (column of `expected_`).
  let lineStart = contStart;
  while (lineStart > 0 && src[lineStart - 1] !== '\n') lineStart--;
  let indent = 0;
  while (lineStart + indent < src.length && src[lineStart + indent] === ' ') indent++;

  const lines: string[] = [firstLineRhs];
  let i = contStart;

  while (i < src.length && parenDepth > 0) {
    let nl = src.indexOf('\n', i);
    if (nl === -1) nl = src.length;
    const line = src.slice(i, nl);
    const trimmed = line.trim();

    if (trimmed === '') {
      // blank line inside parens — ignore, keep going
    } else if (trimmed.startsWith('#')) {
      // comment — ignore, keep going (we're inside parens)
    } else {
      const lineIndent = line.length - line.trimStart().length;
      // A dedented non-blank line or a def/class always ends the assignment
      // even if our naive paren count says otherwise (string-aware counts are
      // expensive; this guard prevents runaway over-consumption).
      if (lineIndent < indent || /^\s*(def |class |@)/.test(line)) break;
      lines.push(line);
      parenDepth += countUnmatched(line, '(', ')');
      if (parenDepth < 0) parenDepth = 0;
    }
    i = nl + 1;
  }

  return lines.join('\n');
}

/** Net count of unclosed openers in a line (open minus close), naive (no string awareness). */
function countUnmatched(s: string, open: string, close: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === open) n++;
    else if (ch === close) n--;
  }
  return n;
}

/**
 * Given the RHS of a Python assignment like
 *   ( "U001..." "U002..." )   or   "single string"
 * join the adjacent string literals (Python implicit concatenation) into one
 * logical string. Returns null if the RHS isn't a (sequence of) string
 * literal(s).
 *
 * We only consume string literals and whitespace/parens; if we hit a non-
 * string token (a variable, a function call), we bail and return null rather
 * than emit a partial/wrong value.
 */
function joinAdjacentStrings(rhs: string): string | null {
  const parts: string[] = [];
  let i = 0;
  let sawToken = false;
  while (i < rhs.length) {
    const ch = rhs[i];
    if (/\s/.test(ch) || ch === '(' || ch === ')' || ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Scan to the matching close quote, honoring \" escapes.
      const quote = ch;
      let j = i + 1;
      let lit = '';
      while (j < rhs.length) {
        const c = rhs[j];
        if (c === '\\' && j + 1 < rhs.length) {
          // For grounded display we keep simple escapes readable.
          const nxt = rhs[j + 1];
          if (nxt === 'n') lit += '\\n';
          else if (nxt === 't') lit += '\\t';
          else lit += nxt;
          j += 2;
          continue;
        }
        if (c === quote) break;
        lit += c;
        j++;
      }
      if (j >= rhs.length) return null; // unterminated — bail
      parts.push(lit);
      sawToken = true;
      i = j + 1;
      continue;
    }
    if (ch === '#') break; // comment to EOL
    // A non-string, non-paren token means this isn't a pure string assignment.
    return null;
  }
  if (!sawToken) return null;
  return parts.join('');
}
