/**
 * Provider configuration map.
 *
 * The agent never hardcodes API keys. It reads the user's environment via
 * [`resolveProviderCredentials`], which maps a provider to the conventional env
 * var. The TUI and the bench SDK both use this helper so there is exactly one
 * place that knows the env-var names and OpenAI-compatible base URLs.
 *
 * Base URLs are the OpenAI-compatible chat-completions endpoints, which is what
 * the coordinator's tool-use loop speaks.
 */

export interface ProviderEndpoint {
  /** Environment variable holding the API key (e.g. "DEEPSEEK_API_KEY"). */
  keyEnv: string;
  /** OpenAI-compatible base URL (no trailing slash). */
  baseUrl: string;
  /** Optional default model if the caller doesn't pick one. */
  defaultModel?: string;
}

const PROVIDERS: Record<string, ProviderEndpoint> = {
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  openai: { keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1' },
  groq: { keyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { keyEnv: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1' },
  together: { keyEnv: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1' },
  fireworks: { keyEnv: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  xai: { keyEnv: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' },
  perplexity: { keyEnv: 'PERPLEXITY_API_KEY', baseUrl: 'https://api.perplexity.ai' },
  ollama: { keyEnv: 'OLLAMA_API_KEY', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
  'lm-studio': { keyEnv: 'LMSTUDIO_API_KEY', baseUrl: 'http://localhost:1234/v1' },
  vllm: { keyEnv: 'VLLM_API_KEY', baseUrl: 'http://localhost:8000/v1' },
  cerebras: { keyEnv: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1' },
  zai: { keyEnv: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4' },
};

export function getProviderEndpoint(provider: string): ProviderEndpoint | undefined {
  return PROVIDERS[provider];
}

export function listConfigurableProviders(): string[] {
  return Object.keys(PROVIDERS).sort();
}

/**
 * Resolve an API key + base URL for a provider from the caller's environment.
 * Returns `{ apiKey: undefined }` when the env var is absent so the caller can
 * decide how to surface that (the TUI prints a hint; the bench throws).
 *
 * An explicitly passed `apiKey` / `baseUrl` always wins.
 */
export function resolveProviderCredentials(opts: {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}): { apiKey: string | undefined; baseUrl: string | undefined } {
  const ep = PROVIDERS[opts.provider];
  const apiKey = opts.apiKey ?? (ep ? process.env[ep.keyEnv] : undefined);
  const baseUrl = opts.baseUrl ?? ep?.baseUrl;
  return { apiKey, baseUrl };
}
