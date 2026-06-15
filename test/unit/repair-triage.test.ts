import { describe, expect, test } from 'bun:test';
import { triageVerifierOutput, buildRepairPrompt } from '../../bench/repair-triage';

// Real (trimmed) verifier outputs from the two failing tasks in
// results-deepseek-v4-flash-tb2-easy.json. These are the regression cases:
//   - cobol-modernization: deliverable missing → must classify as
//     'missing-deliverable' (the OLD near-miss gate missed this entirely
//     because there are zero FAILED lines, only a FileNotFoundError).
//   - overfull-hbox: genuine 1-assertion near-miss → 'near-miss'.

// The pytest tail of the cobol failure. The key signal: "can't open file
// '/app/program.py': [Errno 2] No such file or directory" plus a nonzero
// returncode assertion, with only 2 FAILED lines but the root cause is a
// MISSING file, not a wrong value.
const COBOL_OUTPUT = `_____________________________ test_program_output ______________________________

    def test_program_output():
        Path("/app/src/INPUT.DAT").write_text("U001U003B0030000000020")
        result = subprocess.run(
            ["python", "/app/program.py"], capture_output=True, text=True
        )
>       assert result.returncode == 0, "Command failed"
E       AssertionError: Command failed
E       assert 2 == 0
E        +  where 2 = CompletedProcess(args=['python', '/app/program.py'], returncode=2, stdout='', stderr="python: can't open file '/app/program.py': [Errno 2] No such file or directory\\n").returncode

/tests/test_outputs.py:58: AssertionError
=========================== short test summary info ============================
PASSED ../tests/test_outputs.py::test_data_files_exist
FAILED ../tests/test_outputs.py::test_required_files_exist - AssertionError: ...
FAILED ../tests/test_outputs.py::test_program_output - AssertionError: Comman...
=================== 2 failed, 1 passed, 2 warnings in 0.04s ====================

(reward=0)`;

// The overfull-hbox failure: everything passes except one assertion about
// input.tex matching only allowed synonym substitutions.
const OVERFULL_OUTPUT = `PASSED ../tests/test_outputs.py::test_main_synonyms_not_modified
PASSED ../tests/test_outputs.py::test_compilation_successful
PASSED ../tests/test_outputs.py::test_no_overfull_hboxes
FAILED ../tests/test_outputs.py::test_input_file_matches - AssertionError: mo...
=================== 1 failed, 3 passed, 2 warnings in 18.36s ===================

(reward=0)`;

describe('repair-triage — real failing-task regression cases', () => {
  test('cobol (missing deliverable) classifies as missing-deliverable, not hopeless', () => {
    const t = triageVerifierOutput(COBOL_OUTPUT);
    // The old gate counted FAILED lines (2 here) and called it a near-miss,
    // sending a "your work mostly passed" prompt — wrong, since program.py
    // doesn't exist at all. The new triage must see the missing-file signal.
    expect(t.klass).toBe('missing-deliverable');
    expect(t.failedCount).toBe(2);
    expect(t.ranTests).toBe(true);
    expect(t.reason).toMatch(/missing/i);
  });

  test('overfull-hbox (1 assertion off) classifies as near-miss', () => {
    const t = triageVerifierOutput(OVERFULL_OUTPUT);
    expect(t.klass).toBe('near-miss');
    expect(t.failedCount).toBe(1);
    expect(t.passedCount).toBe(3);
  });
});

describe('repair-triage — classification unit cases', () => {
  test('near-miss with exactly 3 failures', () => {
    const out = 'FAILED a\nFAILED b\nFAILED c\n2 passed';
    expect(triageVerifierOutput(out).klass).toBe('near-miss');
  });

  test('too many failures (>3) is hopeless (not worth one repair round)', () => {
    const out = 'FAILED a\nFAILED b\nFAILED c\nFAILED d\n1 passed';
    expect(triageVerifierOutput(out).klass).toBe('hopeless');
  });

  test('ModuleNotFoundError → missing-deliverable (no FAILED lines)', () => {
    const out = 'collected 2 items\nE   ModuleNotFoundError: No module named foo\nERRORS\n';
    expect(triageVerifierOutput(out).klass).toBe('missing-deliverable');
  });

  test('ImportError → missing-deliverable', () => {
    const out = "collected 1 item\nE   ImportError: cannot import name 'bar'\n";
    expect(triageVerifierOutput(out).klass).toBe('missing-deliverable');
  });

  test('no pytest session at all → hopeless (infra failure)', () => {
    const out = 'Reading package lists... Done\nE: Unable to locate package pytest\n';
    expect(triageVerifierOutput(out).klass).toBe('hopeless');
  });

  test('tests passed but reward=0 (no FAILED) → hopeless (nothing to repair)', () => {
    const out = 'PASSED a\nPASSED b\n2 passed\n(reward=0)';
    expect(triageVerifierOutput(out).klass).toBe('hopeless');
  });
});

describe('buildRepairPrompt — distinct prompts per class', () => {
  const grounding = 'CONTRACT — ...\n  - /app/program.py';

  test('missing-deliverable prompt tells the model to CREATE the file', () => {
    const p = buildRepairPrompt('missing-deliverable', COBOL_OUTPUT, grounding);
    expect(p).toMatch(/CREATE that deliverable/i);
    expect(p).toContain(COBOL_OUTPUT.slice(0, 40));
    expect(p).toContain(grounding); // contract re-armed
  });

  test('near-miss prompt says do NOT start over', () => {
    const p = buildRepairPrompt('near-miss', OVERFULL_OUTPUT, grounding);
    expect(p).toMatch(/do not start over/i);
    expect(p).toContain(grounding);
  });

  test('near-miss prompt directs agent to read the diagnostic artifact (log/output)', () => {
    // The overfull-hbox failure shape: test_no_overfull_hboxes checks main.log,
    // and the real signal (which paragraphs overflow) lives IN that log, not in
    // the pytest output. The prompt must steer the agent to read the artifact.
    const p = buildRepairPrompt('near-miss', OVERFULL_OUTPUT, grounding);
    expect(p).toMatch(/DIAGNOSTIC METHOD/i);
    expect(p).toMatch(/log file/i);
    expect(p).toMatch(/root cause/i);
  });

  test('no grounding → contract section omitted (does not crash)', () => {
    const p = buildRepairPrompt('near-miss', OVERFULL_OUTPUT, '');
    expect(p).not.toContain('CONTRACT');
  });
});
