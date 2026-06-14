/**
 * Agent module entry point
 */

export { AgentCoordinator } from './agent/coordinator';
export type { AgentConfig, AgentEvent, ToolCall } from './agent/types';

export { providerRegistry, AnthropicProvider, OpenAIProvider, GoogleProvider, MistralProvider, OpenRouterProvider } from './model';
export type { Provider, Api, Message, StreamOptions, Model, ProviderInterface } from './model/types';

export { tools, getTool } from './tool';
export type { Tool, ToolResult } from './tool/types';

export { logger } from './utils/logger';
