/**
 * Chat View component - following oh-my-pi rendering quality
 * Displays conversation with proper formatting, code blocks, and tool calls
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from '../types';

interface ChatViewProps {
  messages: ChatMessage[];
}

const ROLE_COLORS = {
  user: 'green',
  assistant: 'cyan',
  system: 'yellow',
  tool: 'magenta'
} as const;

const ROLE_ICONS = {
  user: '👤',
  assistant: '🤖',
  system: '⚙️',
  tool: '🔧'
} as const;

export const ChatView: React.FC<ChatViewProps> = ({ messages }) => {
  const formatMessage = (content: string): React.ReactNode => {
    // Simple code block detection
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push(
          <Text key={`text-${lastIndex}`}>
            {content.substring(lastIndex, match.index)}
          </Text>
        );
      }

      // Add code block
      const language = match[1] || 'text';
      const code = match[2];
      parts.push(
        <Box key={`code-${match.index}`} marginBottom={1} paddingX={1} borderStyle="single" borderColor="gray">
          <Text dimColor>
            {language}
          </Text>
          <Text>
            {'\n'}
            {code}
          </Text>
        </Box>
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      parts.push(
        <Text key={`text-${lastIndex}`}>
          {content.substring(lastIndex)}
        </Text>
      );
    }

    return parts.length > 0 ? parts : <Text>{content}</Text>;
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor>
            Euler Agent ready. Type a message or /help for commands.
          </Text>
        </Box>
      ) : (
        messages.map((msg, idx) => (
          <Box key={idx} marginBottom={1} flexDirection="column">
            {/* Message header */}
            <Box marginBottom={1}>
              <Text bold color={ROLE_COLORS[msg.role] || 'white'}>
                {ROLE_ICONS[msg.role] || '💬'} {msg.role.toUpperCase()}
              </Text>
              {msg.timestamp && (
                <Text dimColor>
                  {' '}• {new Date(msg.timestamp).toLocaleTimeString()}
                </Text>
              )}
            </Box>

            {/* Message content */}
            <Box paddingLeft={2} flexDirection="column">
              {formatMessage(msg.content)}
            </Box>

            {/* Tool call indicator */}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <Box paddingLeft={2} marginTop={1}>
                <Text dimColor>
                  Tools used: {msg.toolCalls.map(tc => tc.name).join(', ')}
                </Text>
              </Box>
            )}
          </Box>
        ))
      )}
    </Box>
  );
};
