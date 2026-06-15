/**
 * Verifier-output triage for the repair loop.
 *
 * The repair loop gives the agent a second shot seeded with the ACTUAL pytest
 * output. But not every failure is worth a retry, and the right retry prompt
 * depends on WHY the task failed:
 *
 *   - **near-miss**: a few assertions FAILED. The deliverable exists and mostly
 *     works. Fix the named assertions.
 *   - **missing-deliverable**: pytest errored because a required file/script is
 *     absent (FileNotFoundError, "No such file or directory", nonzero exit on
 *     import). There is nothing to incrementally fix — the agent must CREATE the
 *     deliverable. This was the cobol failure shape (30 turns, no program.py).
 *   - **hopeless / unrelated**: the verifier itself crashed (apt failed to
 *     install, pytest collection error before any test ran, or too many failures
 *     to repair in one round). Retrying the agent won't help; bail.
 *
 * Centralizing this here keeps the repair loop in sdk.ts readable and makes the
 * classification independently testable.
 */

export type FailureClass = 'near-miss' | 'missing-deliverable' | 'hopeless';

export interface TriageResult {
  klass: FailureClass;
  /** Number of FAILED test lines (0 if none). */
  failedCount: number;
  /** Number of PASSED/collected test lines (0 if none). */
  passedCount: number;
  /** True if pytest collected and ran at least one test. */
  ranTests: boolean;
  /** Short diagnostic string for logging. */
  reason: string;
}

/**
 * Classify a trimmed pytest output into a failure class.
 *
 * `output` should already be trimmed to the pytest-relevant tail
 * (the sdk's trimVerifierOutput does this).
 */
export function triageVerifierOutput(output: string): TriageResult {
  const failedCount = (output.match(/^FAILED\b/gm) ?? []).length;
  const passedCount = (output.match(/^PASSED\b/gm) ?? []).length;
  const errors = (output.match(/^ERRORS\b/gm) ?? []).length;
  const collected = /collected\s+\d+\s+items?/i.test(output);
  const ranTests = collected || passedCount > 0 || failedCount > 0 || errors > 0;

  // Did the deliverable go missing? Look for the signature errors that mean
  // "the file the grader tried to run/read does not exist". These produce zero
  // FAILED lines (the test errors before asserting), so the near-miss gate
  // alone never catches them.
  const missingSignals = [
    /No such file or directory/i,
    /FileNotFoundError/,
    /can't open file/i,
    /ModuleNotFoundError/,
    /ImportError/i,
    /No module named/i,
    /Errno 2\b/,
  ];
  const looksMissing = missingSignals.some((re) => re.test(output));

  // Did pytest even run? If test.sh itself blew up (apt install failed, no
  // python), there's no pytest output at all and retrying the agent is
  // pointless.
  const noPytest = !/test session starts/i.test(output) && !ranTests;

  // Decision order:
  // 1. hopeless — verifier infrastructure failed, not the agent's solution.
  if (noPytest) {
    return {
      klass: 'hopeless',
      failedCount,
      passedCount,
      ranTests,
      reason: 'no pytest session in verifier output (infra failure, not agent work)',
    };
  }

  // 2. missing-deliverable — tests ran (or tried to) but the failure is a
  //    missing file/module, not a wrong value. This MUST be checked BEFORE the
  //    near-miss gate: when a required file is absent, the FAILED count is
  //    misleading (those tests failed BECAUSE the file is missing, not because
  //    of a wrong value). With the grounding contract in the prompt this is now
  //    recoverable: re-issue the instruction with the error evidence + contract.
  if (looksMissing) {
    return {
      klass: 'missing-deliverable',
      failedCount,
      passedCount,
      ranTests,
      reason: 'verifier failed on a missing file/module — deliverable likely absent',
    };
  }

  // 3. near-miss — tests ran and a SMALL number failed on wrong values. The
  //    classic sweet spot for an incremental repair.
  if (failedCount > 0 && failedCount <= 3) {
    return {
      klass: 'near-miss',
      failedCount,
      passedCount,
      ranTests,
      reason: `${failedCount} assertion(s) FAILED (partial pass)`,
    };
  }

  // 4. many failures with no missing-file signal — too far off to repair in
  //    one round; don't burn the budget.
  if (failedCount > 3) {
    return {
      klass: 'hopeless',
      failedCount,
      passedCount,
      ranTests,
      reason: `${failedCount} failures — too far from passing to repair in one round`,
    };
  }

  // 5. tests ran, nothing failed, but reward is still 0 (e.g. all skipped, or
  //    reward written elsewhere). Nothing concrete to repair on.
  return {
    klass: 'hopeless',
    failedCount,
    passedCount,
    ranTests,
    reason: 'no FAILED lines and no missing-file signal — nothing actionable to repair',
  };
}

/**
 * Build the repair prompt for a given triage class. The near-miss and
 * missing-deliverable cases get distinct, appropriately-framed prompts; both
 * append the grounding contract so the model has the exact paths/outputs.
 */
export function buildRepairPrompt(
  klass: FailureClass,
  trimmedOutput: string,
  grounding: string,
): string {
  const contract = grounding
    ? `\n\nThe grader contract (from tests/test_outputs.py):\n${grounding}`
    : '';

  if (klass === 'missing-deliverable') {
    return (
      'The grader ran and FAILED because a required file or module the grader ' +
      'expects is MISSING. Here is the exact pytest output showing the missing ' +
      'file:\n\n' +
      trimmedOutput +
      '\n\nLook at the first error above: it names the exact file/module/path the ' +
      'grader could not find. CREATE that deliverable now with write(). Do not ' +
      're-explore — the CONTRACT below tells you the exact paths and expected ' +
      'outputs the grader checks. Match them precisely, then run the deliverable ' +
      'yourself to confirm it works before stopping.' +
      contract
    );
  }

  // near-miss
  return (
    'The grader just ran against your work and FAILED. Here is the exact pytest ' +
    'output:\n\n' +
    trimmedOutput +
    '\n\nFix the failing assertions. Read the failing test in ' +
    '/tests/test_outputs.py to see exactly what is expected, then edit your ' +
    'deliverable to match. Do NOT start over — your previous work mostly passed; ' +
    'only the FAILED tests need fixing.\n\n' +
    'DIAGNOSTIC METHOD: do not guess. Run the deliverable the EXACT way the ' +
    'grader does and inspect its real output. If a failing test checks a log ' +
    'file (e.g. /app/main.log), a generated file, or command stdout/stderr, ' +
    'READ that artifact directly — it contains the precise diagnostic the test ' +
    'is reacting to (e.g. the exact "Overfull \\hbox" lines naming which ' +
    'paragraphs overflow and by how many pts). Fix the ROOT cause shown there, ' +
    'not a symptom. After each fix, re-run the deliverable to confirm the ' +
    'specific failure is gone before moving on.' +
    contract
  );
}
