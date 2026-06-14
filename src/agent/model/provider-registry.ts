/**
 * Enhanced provider registry with roles and fallback chains
 */

import type { Provider, ProviderInterface } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
import { GoogleProvider } from './providers/google';
import { MistralProvider } from './providers/mistral';
import { OpenRouterProvider } from './providers/openrouter';
import { CodingPlanProvider } from './coding-plan';
import { FallbackChain } from './fallback-chain';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  role?: 'default' | 'smol' | 'slow' | 'plan' | 'commit';
  fallbackChain?: string[];
  subscriptionKey?: string;
}

function createFallbackChain(
  primary: ProviderInterface,
  configs: Map<string, ProviderConfig>,
  registry: EnhancedProviderRegistry,
  name: string
): ProviderInterface | undefined {
  const config = configs.get(name);
  if (!config?.fallbackChain) return undefined;

  const chainProviders = config.fallbackChain
    .map(p => registry.get(p as Provider))
    .filter((p): p is ProviderInterface => p !== undefined);

  if (chainProviders.length === 0) return undefined;

  return new FallbackChain([
    { name, provider: primary },
    ...chainProviders.map((p, i) => ({ name: config.fallbackChain![i], provider: p }))
  ]);
}

function wrapWithCodingPlan(
  instance: ProviderInterface,
  config: ProviderConfig | undefined
): ProviderInterface | undefined {
  if (!config?.subscriptionKey || config.role !== 'plan') return undefined;

  return new CodingPlanProvider(config.subscriptionKey, instance);
}

class EnhancedProviderRegistry {
  private providers = new Map<Provider, () => ProviderInterface>();
  private configs = new Map<Provider, ProviderConfig>();
  private roleProviders = new Map<string, Provider>();

  constructor() {
    this.registerProvider('anthropic', () => new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
    this.registerProvider('openai', () => new OpenAIProvider(process.env.OPENAI_API_KEY));
    this.registerProvider('google', () => new GoogleProvider(process.env.GOOGLE_API_KEY));
    this.registerProvider('mistral', () => new MistralProvider(process.env.MISTRAL_API_KEY));
    this.registerProvider('openrouter', () => new OpenRouterProvider(process.env.OPENROUTER_API_KEY));
  }

  registerProvider(provider: Provider, factory: () => ProviderInterface): void {
    this.providers.set(provider, factory);
  }

  configure(provider: Provider, config: ProviderConfig): void {
    this.configs.set(provider, { ...this.configs.get(provider), ...config });
  }

  setRole(role: string, provider: Provider): void {
    this.roleProviders.set(role, provider);
  }

  get(provider: Provider): ProviderInterface | undefined {
    const config = this.configs.get(provider);
    const factory = this.providers.get(provider);

    if (!factory) return undefined;

    const instance = factory();

    const fallbackChain = createFallbackChain(instance, this.configs, this, provider);
    if (fallbackChain) return fallbackChain;

    const codingPlan = wrapWithCodingPlan(instance, config);
    if (codingPlan) return codingPlan;

    return instance;
  }

  getByRole(role: string): ProviderInterface | undefined {
    const provider = this.roleProviders.get(role);
    return provider ? this.get(provider) : undefined;
  }

  list(): Provider[] {
    return Array.from(this.providers.keys());
  }

  listRoles(): string[] {
    return Array.from(this.roleProviders.keys());
  }
}

export const providerRegistry = new EnhancedProviderRegistry();
