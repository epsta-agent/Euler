/**
 * Selector component - interactive choice selection
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface SelectorOption {
  label: string;
  description?: string;
  value: string;
  recommended?: boolean;
}

interface SelectorProps {
  options: SelectorOption[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  title?: string;
}

export const Selector: React.FC<SelectorProps> = ({
  options,
  onSelect,
  onCancel,
  title = 'Select an option'
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleSelect = useCallback(() => {
    onSelect(options[selectedIndex].value);
  }, [selectedIndex, options, onSelect]);

  useInput((input, key) => {
    if (key.return) {
      handleSelect();
    } else if (key.escape) {
      onCancel();
    } else if (key.upArrow || key.ctrl && input === 'p') {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow || key.ctrl && input === 'n') {
      setSelectedIndex(i => Math.min(options.length - 1, i + 1));
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
      </Box>
      {options.map((option, idx) => (
        <Box key={option.value}>
          <Text color={idx === selectedIndex ? 'green' : 'gray'}>
            {idx === selectedIndex ? '▶' : ' '} {option.label}
            {option.recommended && ' (Recommended)'}
          </Text>
          {option.description && (
            <Box marginLeft={3}>
              <Text dimColor>{option.description}</Text>
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · enter select · esc cancel
        </Text>
      </Box>
    </Box>
  );
};
