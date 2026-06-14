/**
 * Model selector component - comprehensive provider/model selection matching oh-my-pi
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Model {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

interface Provider {
  name: string;
  models: Model[];
  authenticated: boolean;
  category?: 'frontier' | 'cloud' | 'coding-plan' | 'regional' | 'local';
}

interface ModelSelectorProps {
  onSelect: (provider: string, model: string) => void;
  providers: Provider[];
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ onSelect, providers }) => {
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [view, setView] = useState<'providers' | 'models'>('providers');

  const currentProvider = providers[providerIndex];
  const currentModels = currentProvider?.models || [];
  const currentModel = currentModels[modelIndex];

  useInput((input, key) => {
    if (view === 'providers') {
      if (key.return) {
        if (currentProvider && currentProvider.authenticated) {
          setView('models');
          setModelIndex(0);
        }
      } else if (key.upArrow) {
        setProviderIndex((i) => (i > 0 ? i - 1 : providers.length - 1));
      } else if (key.downArrow) {
        setProviderIndex((i) => (i < providers.length - 1 ? i + 1 : 0));
      } else if (key.escape) {
        process.exit(0);
      }
    } else {
      if (key.return) {
        if (currentModel) {
          onSelect(currentProvider.name, currentModel.id);
        }
      } else if (key.escape) {
        setView('providers');
      } else if (key.upArrow) {
        setModelIndex((i) => (i > 0 ? i - 1 : currentModels.length - 1));
      } else if (key.downArrow) {
        setModelIndex((i) => (i < currentModels.length - 1 ? i + 1 : 0));
      }
    }
  });

  // Group providers by category
  const frontierProviders = providers.filter(p => p.category === 'frontier');
  const cloudProviders = providers.filter(p => p.category === 'cloud');
  const codingPlanProviders = providers.filter(p => p.category === 'coding-plan');
  const regionalProviders = providers.filter(p => p.category === 'regional');
  const localProviders = providers.filter(p => p.category === 'local');

  if (view === 'providers') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold>Select Provider:</Text>
        </Box>

        {frontierProviders.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor bold>Frontier APIs</Text>
            {frontierProviders.map((provider, idx) => {
              const globalIdx = providers.indexOf(provider);
              return (
                <Box key={provider.name}>
                  <Text color={globalIdx === providerIndex ? 'green' : 'gray'}>
                    {globalIdx === providerIndex ? '▶' : ' '} {provider.name}
                    {!provider.authenticated && ' (no API key)'}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {cloudProviders.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor bold>Cloud Platforms</Text>
            {cloudProviders.map((provider, idx) => {
              const globalIdx = providers.indexOf(provider);
              return (
                <Box key={provider.name}>
                  <Text color={globalIdx === providerIndex ? 'green' : 'gray'}>
                    {globalIdx === providerIndex ? '▶' : ' '} {provider.name}
                    {!provider.authenticated && ' (no API key)'}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {codingPlanProviders.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor bold>Coding Plans (Subscription)</Text>
            {codingPlanProviders.map((provider, idx) => {
              const globalIdx = providers.indexOf(provider);
              return (
                <Box key={provider.name}>
                  <Text color={globalIdx === providerIndex ? 'green' : 'gray'}>
                    {globalIdx === providerIndex ? '▶' : ' '} {provider.name}
                    {!provider.authenticated && ' (no API key)'}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {regionalProviders.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor bold>Regional/Chinese Providers</Text>
            {regionalProviders.map((provider, idx) => {
              const globalIdx = providers.indexOf(provider);
              return (
                <Box key={provider.name}>
                  <Text color={globalIdx === providerIndex ? 'green' : 'gray'}>
                    {globalIdx === providerIndex ? '▶' : ' '} {provider.name}
                    {!provider.authenticated && ' (no API key)'}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {localProviders.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor bold>Local/Self-hosted</Text>
            {localProviders.map((provider, idx) => {
              const globalIdx = providers.indexOf(provider);
              return (
                <Box key={provider.name}>
                  <Text color={globalIdx === providerIndex ? 'green' : 'gray'}>
                    {globalIdx === providerIndex ? '▶' : ' '} {provider.name}
                    {!provider.authenticated && ' (no API key)'}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>↑↓ Navigate • Enter to select • Esc to quit</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Select Model ({currentProvider.name}):</Text>
      </Box>
      {currentModels.map((model, idx) => (
        <Box key={model.id}>
          <Text color={idx === modelIndex ? 'green' : 'gray'}>
            {idx === modelIndex ? '▶' : ' '} {model.name}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>↑↓ Navigate • Enter to start • Esc for providers</Text>
      </Box>
    </Box>
  );
};
