/**
 * Permission prompt - confirm destructive operations
 */

import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface PermissionPromptProps {
  operation: string;
  target: string;
  onApprove: () => void;
  onDeny: () => void;
  applyToAll?: boolean;
  onApplyToAllChange?: (value: boolean) => void;
}

export const PermissionPrompt: React.FC<PermissionPromptProps> = ({
  operation,
  target,
  onApprove,
  onDeny,
  applyToAll = false,
  onApplyToAllChange
}) => {
  const handleApprove = useCallback(() => {
    onApprove();
  }, [onApprove]);

  const handleDeny = useCallback(() => {
    onDeny();
  }, [onDeny]);

  const handleToggleApplyToAll = useCallback(() => {
    onApplyToAllChange?.(!applyToAll);
  }, [applyToAll, onApplyToAllChange]);

  useInput((input, key) => {
    if (key.return) {
      handleApprove();
    } else if (key.escape) {
      handleDeny();
    } else if (input === 'a' && onApplyToAllChange) {
      handleToggleApplyToAll();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="double">
      <Box marginBottom={1}>
        <Text bold color="yellow">⚠ Permission Required</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{operation}: {target}</Text>
      </Box>
      {onApplyToAllChange && (
        <Box marginBottom={1}>
          <Text>
            [{applyToAll ? 'X' : ' '}] Apply to all (press a)
          </Text>
        </Box>
      )}
      <Box>
        <Text color="green">Enter to approve</Text>
        <Text color="red"> · Esc to deny</Text>
      </Box>
    </Box>
  );
};
