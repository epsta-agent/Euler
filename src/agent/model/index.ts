/**
 * Model layer entry point with enhanced features
 */

export type {
  Provider,
  Api,
  Message,
  ContentBlock,
  StreamOptions,
  Model,
  StreamChunk,
  StreamCallback,
  ProviderInterface,
  ProviderRegistry,
} from './types';

export { providerRegistry } from './provider-registry';
export type { ProviderConfig } from './provider-registry';

export { CodingPlanProvider } from './coding-plan';
export { FallbackChain } from './fallback-chain';

export {
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  MistralProvider,
  OpenRouterProvider,
} from './providers';
