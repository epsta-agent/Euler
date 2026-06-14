# Terminal-Bench evaluator. Runs in the agent's working directory.
# Verifies summary.sh exists, is executable, and prints the right three lines.

import os
import re
import subprocess
from pathlib import Path


def _run_summary():
    script = Path("summary.sh")
    assert script.exists(), "summary.sh must exist in the working directory"
    assert os.access(script, os.X_OK), "summary.sh must be executable"
    proc = subprocess.run(
        ["./summary.sh"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, f"summary.sh exited {proc.returncode}; stderr:\n{proc.stderr}"
    return proc.stdout.strip().splitlines()


def test_three_lines_only():
    lines = _run_summary()
    assert len(lines) == 3, f"expected exactly 3 lines, got {len(lines)}: {lines}"


def test_total_requests():
    lines = _run_summary()
    m = re.match(r"Total requests:\s*(\d+)$", lines[0])
    assert m, f"line 1 wrong format: {lines[0]!r}"
    assert int(m.group(1)) == 7, f"expected 7 total requests, got {m.group(1)}"


def test_404_errors():
    lines = _run_summary()
    m = re.match(r"404 errors:\s*(\d+)$", lines[1])
    assert m, f"line 2 wrong format: {lines[1]!r}"
    assert int(m.group(1)) == 3, f"expected 3 404 errors, got {m.group(1)}"


def test_unique_ips():
    lines = _run_summary()
    m = re.match(r"Unique IPs:\s*(\d+)$", lines[2])
    assert m, f"line 3 wrong format: {lines[2]!r}"
    assert int(m.group(1)) == 4, f"expected 4 unique IPs, got {m.group(1)}"
