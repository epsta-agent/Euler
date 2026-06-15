import { describe, expect, test } from 'bun:test';
import { groundFromSource } from '../../bench/test-grounding';

// The actual tests/test_outputs.py from the two failing tasks, lightly trimmed
// to the parts the extractor must handle. These are the regression cases: if
// the grounding stops surfacing the cobol expected outputs or the overfull-hbox
// input-file contract, a near-miss turns back into a fail.

const COBOL_TEST = `import subprocess
from pathlib import Path

def test_required_files_exist():
    """Test that all required Python files exist"""
    required_files = [
        "/app/program.py",
    ]
    for file_path in required_files:
        assert Path(file_path).exists(), f"Required file {file_path} does not exist"

def test_data_files_exist():
    data_files = [
        "/app/data/ACCOUNTS.DAT",
        "/app/data/BOOKS.DAT",
        "/app/data/TRANSACTIONS.DAT",
        "/app/src/INPUT.DAT",
    ]
    for file_path in data_files:
        assert Path(file_path).exists()

def test_program_output():
    initial_accounts = (
        "U001John Doe            0000001000U002Jane Smith"
        "          0000002000U003Bob Wilson          0000001500"
    )
    Path("/app/src/INPUT.DAT").write_text("U001U003B0030000000020")
    result = subprocess.run(["python", "/app/program.py"], capture_output=True, text=True)
    assert result.returncode == 0, "Command failed"

    expected_accounts = (
        "U001John Doe            0000001180U002Jane Smith          "
        "0000001800U003Bob Wilson          0000001520"
    )
    expected_books = (
        "B001Python Basics       U002B002COBOL Guide         "
        "U002B003Java Tutorial       U002"
    )
    expected_transactions = (
        "B0030000000020U003U001B0030000000050U001U002B0010000000150U001U002"
    )
    assert (data_dir / "ACCOUNTS.DAT").read_text() == expected_accounts
`;

describe('test-grounding — cobol-modernization (regression)', () => {
  const g = groundFromSource(COBOL_TEST);

  test('surfaces /app/program.py as a required file', () => {
    expect(g).toContain('/app/program.py');
  });

  test('surfaces the data files the grader checks', () => {
    expect(g).toContain('/app/data/ACCOUNTS.DAT');
    expect(g).toContain('/app/data/BOOKS.DAT');
  });

  test('lists the three test functions', () => {
    expect(g).toContain('test_required_files_exist');
    expect(g).toContain('test_data_files_exist');
    expect(g).toContain('test_program_output');
  });

  test('surfaces the joined expected_accounts literal (implicit concat)', () => {
    // The cobol test splits expected_accounts across two adjacent string
    // literals. The grounding MUST join them into the single logical value,
    // because that concatenated string IS the ground-truth output.
    expect(g).toContain('expected_accounts: ');
    expect(g).toContain('0000001180');     // first half
    expect(g).toContain('0000001800U003'); // across the join
    expect(g).toContain('0000001520');     // second half
  });

  test('surfaces expected_books and expected_transactions', () => {
    expect(g).toContain('expected_books:');
    expect(g).toContain('expected_transactions:');
    expect(g).toContain('B0030000000020U003U001');
  });

  test('surfaces the returncode == 0 numeric assertion', () => {
    expect(g).toMatch(/assert ==.*0/);
  });
});

describe('test-grounding — overfull-hbox (regression)', () => {
  const OVERFULL_TEST = `import os, re, shutil
from pathlib import Path
import pytest

@pytest.fixture(scope="session", autouse=True)
def compile_document():
    shutil.copy2(test_dir / "main.tex", work_dir / "main_original.tex")

def test_main_synonyms_not_modified():
    """Check that main.tex and synonyms.txt were not modified"""
    assert Path("/app/main.tex").exists()
    assert Path("/app/synonyms.txt").exists()

def test_compilation_successful():
    """Check for a successful compilation identifier in the log"""
    with open(log_path, "r") as f:
        log_content = f.read()
    assert "Output written on main.pdf" in log_content

def test_no_overfull_hboxes():
    log_content = ...
    assert "Overfull \\\\hbox" not in log_content

def test_input_file_matches():
    """Compare agent's input.tex to original, ensure only allowed substitutions"""
    error_str = "modified input.tex must only modify words in synonyms.txt"
`;

  const g = groundFromSource(OVERFULL_TEST);

  test('surfaces the do-not-modify files', () => {
    expect(g).toContain('/app/main.tex');
    expect(g).toContain('/app/synonyms.txt');
  });

  test('surfaces all four test functions with their docstrings', () => {
    expect(g).toMatch(/test_main_synonyms_not_modified.*not modified/);
    expect(g).toMatch(/test_compilation_successful.*compilation identifier/);
    expect(g).toContain('test_no_overfull_hboxes');
    expect(g).toMatch(/test_input_file_matches.*allowed substitutions/);
  });
});

describe('test-grounding — pure unit behavior', () => {
  test('empty/whitespace source yields empty contract', () => {
    expect(groundFromSource('')).toBe('');
    expect(groundFromSource('   \n  ')).toBe('');
  });

  test('source with no test files/functions yields empty contract', () => {
    const src = 'x = 1\nprint("hi")\n';
    expect(groundFromSource(src)).toBe('');
  });

  test('numeric expected value surfaced', () => {
    const src = 'expected_count = 42\n';
    const g = groundFromSource(src);
    expect(g).toContain('expected_count: 42');
  });

  test('float expected value surfaced', () => {
    const src = 'expected_ratio = 0.5\n';
    const g = groundFromSource(src);
    expect(g).toContain('expected_ratio: 0.5');
  });

  test('respects maxLiteralLines cap', () => {
    let src = '';
    for (let i = 0; i < 10; i++) src += `expected_v${i} = "val${i}"\n`;
    const g = groundFromSource(src, { maxLiteralLines: 3 });
    // 3 literal lines + required-files/tests sections; just check the cap held.
    const literalLines = g.split('\n').filter((l) => l.startsWith('  - expected_'));
    expect(literalLines.length).toBeLessThanOrEqual(3);
  });

  test('does not surface /tests or /root paths as required files', () => {
    const src = 'assert Path("/tests/main.tex").exists()\nassert Path("/app/x.py").exists()\n';
    const g = groundFromSource(src);
    expect(g).not.toContain('/tests/main.tex');
    expect(g).toContain('/app/x.py');
  });

  test('non-string RHS on expected_ assignment is not surfaced as a string', () => {
    // expected_x = compute() — RHS is a call, not a literal. Must NOT emit a
    // bogus string value.
    const src = 'expected_x = compute()\nexpected_y = "real"\n';
    const g = groundFromSource(src);
    expect(g).not.toContain('expected_x:');
    expect(g).toContain('expected_y: real');
  });

  test('unterminated string literal does not crash and is skipped', () => {
    const src = 'expected_x = "unterminated\nexpected_y = "ok"\n';
    // Should not throw; should still surface the valid one.
    const g = groundFromSource(src);
    expect(g).toContain('expected_y: ok');
  });
});
