/**
 * Configuration management for Euler Agent
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';

export interface Config {
  provider:
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'google-vertex'
    | 'mistral'
    | 'azure-openai'
    | 'amazon-bedrock'
    | 'openrouter'
    | 'xai'
    | 'groq'
    | 'deepseek'
    | 'openai-codex'
    | 'cohere'
    | 'perplexity'
    | 'fireworks'
    | 'together'
    | 'huggingface'
    | 'cursor'
    | 'github-copilot'
    | 'ollama'
    | 'lm-studio'
    | 'vllm'
    | 'cerebras'
    | 'cloudflare-ai-gateway'
    | 'cloudflare-workers-ai'
    | 'vercel-ai-gateway'
    | 'zai'
    | 'opencode'
    | 'opencode-go'
    | 'kimi-coding'
    | 'minimax'
    | 'minimax-cn'
    | 'xiaomi'
    | 'xiaomi-token-plan-cn'
    | 'xiaomi-token-plan-ams'
    | 'xiaomi-token-plan-sgp';
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Config = {
  provider: '' as any, // No default - user must select
  model: '', // No default - user must select
  temperature: 0.7,
  maxTokens: 8192,
};

export class ConfigManager {
  private globalConfigPath: string;
  private projectConfigPath: string;
  private config: Config;

  constructor(projectDir?: string) {
    this.globalConfigPath = join(homedir(), '.euler', 'config.json');
    const cwd = projectDir || process.cwd();
    this.projectConfigPath = join(cwd, '.euler', 'config.json');
    this.config = { ...DEFAULT_CONFIG };
  }

  async load(): Promise<Config> {
    // Load global config first
    try {
      const content = await readFile(this.globalConfigPath, 'utf-8');
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    } catch {
      // Global config doesn't exist, try project config
    }

    // Overlay project config if it exists
    try {
      const content = await readFile(this.projectConfigPath, 'utf-8');
      this.config = { ...this.config, ...JSON.parse(content) };
    } catch {
      // Project config doesn't exist, use global config
    }

    return this.config;
  }

  async save(config: Partial<Config>): Promise<void> {
    this.config = { ...this.config, ...config };

    // Ensure directory exists
    await mkdir(join(homedir(), '.euler'), { recursive: true });

    // Always save to global config for persistence
    await writeFile(this.globalConfigPath, JSON.stringify(this.config, null, 2));
  }

  get(): Config {
    return { ...this.config };
  }

  async set(key: keyof Config, value: Config[keyof Config]): Promise<void> {
    await this.save({ [key]: value });
  }
}

export async function getGlobalConfigPath(): Promise<string> {
  return join(homedir(), '.euler', 'config.json');
}

export async function getProjectConfigPath(cwd?: string): Promise<string> {
  return join(cwd || process.cwd(), '.euler', 'config.json');
}
