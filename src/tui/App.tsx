/**
 * Main TUI application component - following oh-my-pi architecture
 * Integrates compaction, plan mode, and improved UI/UX
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ChatView } from './components/ChatView';
import { InputBox } from './components/InputBox';
import { StatusBar } from './components/StatusBar';
import type { ChatMessage } from './types';
import { slashCommandRegistry } from '../slash-commands';
import { planModeManager } from '../agent/modes/plan-mode';

interface AppProps {
  provider: string;
  model: string;
  onSubmit: (input: string) => Promise<string>;
  initialMessages?: ChatMessage[];
}

export const App: React.FC<AppProps> = ({
  provider,
  model,
  onSubmit,
  initialMessages = []
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [status, setStatus] = useState<'idle' | 'processing' | 'error' | 'plan'>('idle');
  const [error, setError] = useState<string>();
  const [currentProvider, setCurrentProvider] = useState(provider);
  const [currentModel, setCurrentModel] = useState(model);
  const [compacted, setCompacted] = useState(0);
  const [thinking, setThinking] = useState<'off' | 'low' | 'medium' | 'high' | 'xhigh'>('off');

  // Parse thinking level from model
  useEffect(() => {
    if (model.includes(':')) {
      const level = model.split(':')[1] as any;
      setThinking(level || 'off');
    }
  }, [model]);

  // Load initial messages when they change
  useEffect(() => {
    if (initialMessages.length > 0) {
      setMessages(initialMessages);
    }
  }, [initialMessages]);

  const handleSubmit = useCallback(async (input: string) => {
    // Check if input is a slash command
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(' ');
      const commandName = parts[0];
      const args = parts.slice(1);

      try {
        const result = await slashCommandRegistry.execute(commandName, args);

        // Add system message for command feedback
        const systemMessage: ChatMessage = {
          role: 'system',
          content: result,
          timestamp: Date.now()
        };

        setMessages(prev => [...prev, systemMessage]);
      } catch (err) {
        const errorMessage: ChatMessage = {
          role: 'system',
          content: `Command error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          timestamp: Date.now()
        };

        setMessages(prev => [...prev, errorMessage]);
      }
      return;
    }

    // Regular message
    const userMessage: ChatMessage = {
      role: 'user',
      content: input,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setStatus('processing');

    try {
      const response = await onSubmit(input);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response,
        timestamp: Date.now()
      };

      setMessages(prev => [...prev, assistantMessage]);
      setStatus('idle');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      setStatus('error');

      setTimeout(() => {
        setStatus('idle');
        setError(undefined);
      }, 3000);
    }
  }, [onSubmit]);

  const planModeEnabled = planModeManager.isEnabled();

  return (
    <Box flexDirection="column" height="100%" width="100%" paddingY={1}>
      <StatusBar
        status={planModeEnabled ? 'plan' : status}
        provider={currentProvider}
        model={currentModel}
        messageCount={messages.length}
        compacted={compacted}
        thinking={thinking}
        planMode={planModeEnabled}
      />
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        <ChatView messages={messages} />
        {error && (
          <Box paddingY={1}>
            <Text color="red">Error: {error}</Text>
          </Box>
        )}
      </Box>
      <InputBox onSubmit={handleSubmit} status={status} />
    </Box>
  );
};
