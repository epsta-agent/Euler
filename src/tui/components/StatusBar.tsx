/**
 * Status Bar component - following oh-my-pi rendering quality
 * Shows provider, model, status, thinking level, compaction info, and message count
 */

import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  status: 'idle' | 'processing' | 'error' | 'plan';
  provider: string;
  model: string;
  messageCount?: number;
  compacted?: number;
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  planMode?: boolean;
}

const STATUS_COLORS = {
  idle: 'gray',
  processing: 'yellow',
  error: 'red',
  plan: 'blue'
} as const;

const STATUS_ICONS = {
  idle: '●',
  processing: '◐',
  error: '●',
  plan: '◉'
} as const;

export const StatusBar: React.FC<StatusBarProps> = ({
  status,
  provider,
  model,
  messageCount = 0,
  compacted = 0,
  thinking,
  planMode = false
}) => {
  const statusColor = STATUS_COLORS[status];
  const statusIcon = STATUS_ICONS[status];

  // Parse model for thinking level
  const thinkingLevel = thinking || (model.includes(':') ? model.split(':')[1] as any : 'off');

  return (
    <Box
      borderStyle="single"
      borderColor={statusColor}
      paddingX={1}
      width="100%"
    >
      <Box justifyContent="space-between" width="100%">
        {/* Left side: Status and model info */}
        <Box>
          <Text color={statusColor} bold>
            {statusIcon}
          </Text>
          <Text color={statusColor}>
            {' '}
            {status.toUpperCase()}
          </Text>

          {planMode && (
            <>
              <Text color="blue" bold>
                {' '}[PLAN]
              </Text>
            </>
          )}

          <Text dimColor>
            {' '}| {provider}/{model}
          </Text>

          {thinkingLevel !== 'off' && (
            <Text color="cyan">
              {' '}🧠 {thinkingLevel.toUpperCase()}
            </Text>
          )}
        </Box>

        {/* Right side: Message info */}
        <Box>
          {compacted > 0 && (
            <Text color="green">
              ⚡ {compacted}
            </Text>
          )}

          <Text dimColor>
            {' '}💬 {messageCount}
          </Text>

          {messageCount > 50 && (
            <Text color="yellow">
              {' '}⚠️
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
