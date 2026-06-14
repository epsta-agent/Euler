#!/bin/bash
echo "Testing Euler Agent startup..."
echo "TTY status: $([ -t 0 ] && echo 'YES' || echo 'NO')"
echo "Starting Euler Agent..."
timeout 5 bun src/cli.tsx 2>&1 || echo "Exit code: $?"
