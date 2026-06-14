/**
 * Input box component - handles user input with command hints
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { slashCommandRegistry } from '../../slash-commands';

interface InputBoxProps {
  onSubmit: (input: string) => void;
  status: 'idle' | 'processing' | 'error' | 'plan';
}

export const InputBox: React.FC<InputBoxProps> = ({ onSubmit, status }) => {
  const [input, setInput] = useState('');

  // Get matching commands for hints
  const commandHint = useMemo(() => {
    if (!input.startsWith('/')) return null;

    const commandPart = input.slice(1);
    const matchingCommands = slashCommandRegistry.list()
      .filter(cmd => cmd.name.startsWith(commandPart))
      .slice(0, 3); // Show max 3 matches

    if (matchingCommands.length === 0) return null;
    return matchingCommands;
  }, [input]);

  useInput((inputChar, key) => {
    if (status === 'processing') return;

    if (key.return) {
      if (input.trim()) {
        onSubmit(input.trim());
        setInput('');
      }
    } else if (key.escape) {
      setInput('');
    } else if (key.ctrl && inputChar === 'c') {
      process.exit(0);
    } else if (key.backspace || key.delete) {
      setInput(input.slice(0, -1));
    } else if (inputChar) {
      setInput(input + inputChar);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={status === 'processing' ? 'yellow' : 'green'}>
          {status === 'processing' ? '●' : '▶'}
        </Text>
        <Text> </Text>
        <Text>{input || '_'}</Text>
      </Box>

      {commandHint && (
        <Box marginTop={1} flexDirection="column">
          {commandHint.map(cmd => (
            <Box key={cmd.name}>
              <Text dimColor color="cyan">
                /{cmd.name}
              </Text>
              <Text dimColor> - {cmd.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {!commandHint && input.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>Enter: send • Esc: clear • Ctrl+C: quit</Text>
        </Box>
      )}
    </Box>
  );
};
