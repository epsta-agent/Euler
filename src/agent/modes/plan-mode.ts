/**
 * Plan mode implementation for Euler Agent
 * Following oh-my-pi's plan/goal mode architecture
 *
 * Plan mode allows the agent to create structured plans before execution,
 * with support for thinking levels and role-based model selection.
 */

export enum ThinkingLevel {
  Off = 'off',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh'
}

export interface ModelRole {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5") */
  model: string;
  /** Optional thinking level suffix (e.g., ":high") */
  thinking?: ThinkingLevel;
}

export interface ResolvedModelRole {
  /** Provider */
  provider?: string;
  /** Model ID */
  model?: string;
  /** Thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Whether thinking level was explicitly specified */
  explicitThinking?: boolean;
}

export interface PlanModeState {
  /** Whether plan mode is enabled */
  enabled: boolean;
  /** Path to plan file */
  planFilePath?: string;
  /** Current plan content */
  planContent?: string;
  /** Plan steps */
  steps?: PlanStep[];
}

export interface PlanStep {
  /** Step number */
  number: number;
  /** Step description */
  description: string;
  /** Step status */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  /** Dependencies on other steps */
  dependencies?: number[];
  /** Estimated complexity */
  complexity?: 'low' | 'medium' | 'high';
}

/**
 * Parse model role string (e.g., "anthropic/claude-sonnet-4-5:xhigh")
 */
export function parseModelRole(roleString: string): ResolvedModelRole {
  const [modelPart, thinkingPart] = roleString.split(':');

  // Parse provider and model
  const [provider, ...modelParts] = modelPart.split('/');
  const model = modelParts.join('/');

  const result: ResolvedModelRole = {
    provider,
    model
  };

  // Parse thinking level
  if (thinkingPart) {
    const thinking = parseThinkingLevel(thinkingPart);
    if (thinking) {
      result.thinkingLevel = thinking;
      result.explicitThinking = true;
    }
  }

  return result;
}

/**
 * Parse thinking level from string
 */
export function parseThinkingLevel(level: string): ThinkingLevel | undefined {
  const normalized = level.toLowerCase();
  switch (normalized) {
    case 'off':
      return ThinkingLevel.Off;
    case 'low':
      return ThinkingLevel.Low;
    case 'medium':
      return ThinkingLevel.Medium;
    case 'high':
      return ThinkingLevel.High;
    case 'xhigh':
    case 'x-high':
    case 'extra_high':
      return ThinkingLevel.XHigh;
    default:
      return undefined;
  }
}

/**
 * Get thinking level for role
 */
export function getThinkingLevelForRole(
  roleString: string,
  defaultLevel: ThinkingLevel = ThinkingLevel.Medium
): ThinkingLevel {
  const parsed = parseModelRole(roleString);
  return parsed.thinkingLevel || defaultLevel;
}

/**
 * Plan mode manager
 */
export class PlanModeManager {
  private state: PlanModeState = { enabled: false };
  private roles: Map<string, string> = new Map();

  /**
   * Enable plan mode
   */
  enable(planFilePath?: string): void {
    this.state.enabled = true;
    this.state.planFilePath = planFilePath;
  }

  /**
   * Disable plan mode
   */
  disable(): void {
    this.state.enabled = false;
    this.state.planFilePath = undefined;
    this.state.planContent = undefined;
    this.state.steps = undefined;
  }

  /**
   * Check if plan mode is enabled
   */
  isEnabled(): boolean {
    return this.state.enabled;
  }

  /**
   * Get current plan state
   */
  getState(): PlanModeState {
    return { ...this.state };
  }

  /**
   * Set plan content
   */
  setPlanContent(content: string): void {
    this.state.planContent = content;
    this.state.steps = parsePlanSteps(content);
  }

  /**
   * Get plan content
   */
  getPlanContent(): string | undefined {
    return this.state.planContent;
  }

  /**
   * Get plan steps
   */
  getSteps(): PlanStep[] {
    return this.state.steps || [];
  }

  /**
   * Update step status
   */
  updateStepStatus(stepNumber: number, status: PlanStep['status']): void {
    if (!this.state.steps) return;
    const step = this.state.steps.find(s => s.number === stepNumber);
    if (step) {
      step.status = status;
    }
  }

  /**
   * Set model role
   */
  setModelRole(role: string, modelString: string): void {
    this.roles.set(role, modelString);
  }

  /**
   * Get model for role
   */
  getModelForRole(role: string): ResolvedModelRole | undefined {
    const modelString = this.roles.get(role);
    if (!modelString) return undefined;
    return parseModelRole(modelString);
  }

  /**
   * Get all configured roles
   */
  getRoles(): Map<string, string> {
    return new Map(this.roles);
  }
}

/**
 * Parse plan steps from content
 */
function parsePlanSteps(content: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lines = content.split('\n');

  let stepNumber = 0;
  for (const line of lines) {
    // Match numbered steps (1., 2., etc.)
    const match = line.match(/^(\d+)[.\)]\s+(.+)/);
    if (match) {
      stepNumber = parseInt(match[1], 10);
      steps.push({
        number: stepNumber,
        description: match[2].trim(),
        status: 'pending'
      });
    }
  }

  return steps;
}

// Global plan mode manager instance
export const planModeManager = new PlanModeManager();
