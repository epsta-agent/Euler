/**
 * Provider registry and factory - comprehensive provider support matching oh-my-pi
 */

import type { Provider, ProviderInterface, ProviderRegistry } from '../types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';
import { MistralProvider } from './mistral';
import { OpenRouterProvider } from './openrouter';
import { XAIProvider } from './xai';
import { CohereProvider } from './cohere';
import { PerplexityProvider } from './perplexity';
import { GroqProvider } from './groq';
import { DeepSeekProvider } from './deepseek';
import { FireworksProvider } from './fireworks';
import { TogetherProvider } from './together';
import { HuggingFaceProvider } from './huggingface';
import { CursorProvider } from './cursor';
import { GitHubCopilotProvider } from './github-copilot';
import { OllamaProvider } from './ollama';
import { LMStudioProvider } from './lmstudio';
import { VLLMProvider } from './vllm';
import { AzureOpenAIProvider } from './azure-openai';
import { AmazonBedrockProvider } from './amazon-bedrock';
import { CerebrasProvider } from './cerebras';
import { CloudflareAIGatewayProvider } from './cloudflare-ai-gateway';
import { CloudflareWorkersAIProvider } from './cloudflare-workers-ai';
import { VercelAIGatewayProvider } from './vercel-ai-gateway';
import { ZAIProvider } from './zai';
import { OpenCodeProvider } from './opencode';
import { OpenCodeGoProvider } from './opencode-go';
import { KimiCodingProvider } from './kimi-coding';
import { MiniMaxProvider } from './minimax';
import { MiniMaxCNProvider } from './minimax-cn';
import { XiaomiProvider } from './xiaomi';
import { XiaomiTokenPlanCNProvider } from './xiaomi-token-plan-cn';
import { XiaomiTokenPlanAMSProvider } from './xiaomi-token-plan-ams';
import { XiaomiTokenPlanSGPProvider } from './xiaomi-token-plan-sgp';
import { GoogleVertexProvider } from './google-vertex';

class DefaultProviderRegistry implements ProviderRegistry {
  private providers = new Map<Provider, () => ProviderInterface>();

  constructor() {
    // Frontier APIs
    this.register('anthropic', () => new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
    this.register('openai', () => new OpenAIProvider(process.env.OPENAI_API_KEY));
    this.register('google', () => new GoogleProvider(process.env.GEMINI_API_KEY));
    this.register('google-vertex', () => new GoogleVertexProvider(process.env.GOOGLE_CLOUD_ACCESS_TOKEN));
    this.register('mistral', () => new MistralProvider(process.env.MISTRAL_API_KEY));
    this.register('openrouter', () => new OpenRouterProvider(process.env.OPENROUTER_API_KEY));
    this.register('xai', () => new XAIProvider(process.env.XAI_API_KEY));
    this.register('cohere', () => new CohereProvider(process.env.COHERE_API_KEY));
    this.register('perplexity', () => new PerplexityProvider(process.env.PERPLEXITY_API_KEY));
    this.register('groq', () => new GroqProvider(process.env.GROQ_API_KEY));
    this.register('deepseek', () => new DeepSeekProvider(process.env.DEEPSEEK_API_KEY));
    this.register('fireworks', () => new FireworksProvider(process.env.FIREWORKS_API_KEY));
    this.register('together', () => new TogetherProvider(process.env.TOGETHER_API_KEY));
    this.register('huggingface', () => new HuggingFaceProvider(process.env.HUGGINGFACE_API_KEY));
    this.register('cerebras', () => new CerebrasProvider(process.env.CEREBRAS_API_KEY));

    // Cloud Platforms
    this.register('azure-openai', () => new AzureOpenAIProvider(process.env.AZURE_OPENAI_API_KEY));
    this.register('amazon-bedrock', () => new AmazonBedrockProvider());
    this.register('cloudflare-ai-gateway', () => new CloudflareAIGatewayProvider(process.env.CLOUDFLARE_API_KEY));
    this.register('cloudflare-workers-ai', () => new CloudflareWorkersAIProvider(process.env.CLOUDFLARE_API_KEY));
    this.register('vercel-ai-gateway', () => new VercelAIGatewayProvider(process.env.AI_GATEWAY_API_KEY));

    // Coding Plans
    this.register('cursor', () => new CursorProvider(process.env.CURSOR_API_KEY));
    this.register('github-copilot', () => new GitHubCopilotProvider(process.env.GITHUB_TOKEN));
    this.register('openai-codex', () => new OpenAIProvider(process.env.OPENAI_API_KEY));

    // Chinese/Regional Providers
    this.register('zai', () => new ZAIProvider(process.env.ZAI_API_KEY));
    this.register('opencode', () => new OpenCodeProvider(process.env.OPencode_API_KEY));
    this.register('opencode-go', () => new OpenCodeGoProvider(process.env.OPencode_API_KEY));
    this.register('kimi-coding', () => new KimiCodingProvider(process.env.KIMI_API_KEY));
    this.register('minimax', () => new MiniMaxProvider(process.env.MINIMAX_API_KEY));
    this.register('minimax-cn', () => new MiniMaxCNProvider(process.env.MINIMAX_CN_API_KEY));
    this.register('xiaomi', () => new XiaomiProvider(process.env.XIAOMI_API_KEY));
    this.register('xiaomi-token-plan-cn', () => new XiaomiTokenPlanCNProvider(process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY));
    this.register('xiaomi-token-plan-ams', () => new XiaomiTokenPlanAMSProvider(process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY));
    this.register('xiaomi-token-plan-sgp', () => new XiaomiTokenPlanSGPProvider(process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY));

    // Local/Self-hosted
    this.register('ollama', () => new OllamaProvider('ollama'));
    this.register('lm-studio', () => new LMStudioProvider('lm-studio'));
    this.register('vllm', () => new VLLMProvider('vllm'));
  }

  register(provider: Provider, factory: () => ProviderInterface): void {
    this.providers.set(provider, factory);
  }

  get(provider: Provider): ProviderInterface | undefined {
    const factory = this.providers.get(provider);
    return factory?.();
  }

  list(): Provider[] {
    return Array.from(this.providers.keys());
  }
}

export const providerRegistry = new DefaultProviderRegistry();

// Re-export all providers
export { AnthropicProvider } from './anthropic';
export { OpenAIProvider } from './openai';
export { GoogleProvider } from './google';
export { MistralProvider } from './mistral';
export { OpenRouterProvider } from './openrouter';
export { XAIProvider } from './xai';
export { CohereProvider } from './cohere';
export { PerplexityProvider } from './perplexity';
export { GroqProvider } from './groq';
export { DeepSeekProvider } from './deepseek';
export { FireworksProvider } from './fireworks';
export { TogetherProvider } from './together';
export { HuggingFaceProvider } from './huggingface';
export { CursorProvider } from './cursor';
export { GitHubCopilotProvider } from './github-copilot';
export { OllamaProvider } from './ollama';
export { LMStudioProvider } from './lmstudio';
export { VLLMProvider } from './vllm';
export { AzureOpenAIProvider } from './azure-openai';
export { AmazonBedrockProvider } from './amazon-bedrock';
export { CerebrasProvider } from './cerebras';
export { CloudflareAIGatewayProvider } from './cloudflare-ai-gateway';
export { CloudflareWorkersAIProvider } from './cloudflare-workers-ai';
export { VercelAIGatewayProvider } from './vercel-ai-gateway';
export { ZAIProvider } from './zai';
export { OpenCodeProvider } from './opencode';
export { OpenCodeGoProvider } from './opencode-go';
export { KimiCodingProvider } from './kimi-coding';
export { MiniMaxProvider } from './minimax';
export { MiniMaxCNProvider } from './minimax-cn';
export { XiaomiProvider } from './xiaomi';
export { XiaomiTokenPlanCNProvider } from './xiaomi-token-plan-cn';
export { XiaomiTokenPlanAMSProvider } from './xiaomi-token-plan-ams';
export { XiaomiTokenPlanSGPProvider } from './xiaomi-token-plan-sgp';
export { GoogleVertexProvider } from './google-vertex';
