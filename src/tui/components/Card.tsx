/**
 * Card component - displays tool calls, edits, and actions
 */

import React from 'react';
import { Box, Text } from 'ink';

interface CardProps {
  title?: string;
  status: 'pending' | 'success' | 'error' | 'info';
  children: React.ReactNode;
  footer?: string;
}

export const Card: React.FC<CardProps> = ({ title, status, children, footer }) => {
  const statusColors = {
    pending: 'yellow',
    success: 'green',
    error: 'red',
    info: 'blue',
  };

  const statusIcons = {
    pending: '⏳',
    success: '✓',
    error: '✗',
    info: 'ℹ',
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingX={1}
      marginBottom={1}
    >
      {title && (
        <Box>
          <Text color={statusColors[status]} bold>
            {statusIcons[status]} {title}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" paddingY={1}>
        {children}
      </Box>
      {footer && (
        <Box>
          <Text dimColor>{footer}</Text>
        </Box>
      )}
    </Box>
  );
};
