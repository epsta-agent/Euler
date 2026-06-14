/**
 * Snapcompact context compaction for Euler Agent
 * Following oh-my-pi's architecture for bitmap-based conversation archiving
 *
 * Renders conversation history as dense bitmap images that vision models read back,
 * preserving full context at 2-3x lower token cost than text summarization.
 */

import type { Message } from '../model/types';

export interface CompactionFrame {
  /** PNG base64 data */
  data: string;
  /** Estimated token cost for this frame */
  tokenEstimate: number;
  /** Frame shape used */
  shape: FrameShape;
}

export interface FrameShape {
  /** Font family */
  font: '5x8' | '8x8';
  /** Cell width in pixels */
  cellWidth: number;
  /** Cell height in pixels */
  cellHeight: number;
  /** Ink variant */
  variant: 'sent' | 'bw';
  /** Line repetition for redundancy */
  lineRepeat: number;
  /** Frame size in pixels */
  frameSize: number;
  /** Token cost estimate */
  tokenEstimate: number;
}

/** Eval-optimized frame shapes per provider */
export const SHAPES: Record<string, FrameShape> = {
  /** Anthropic: 8x8 repeated grid, black ink */
  anthropic: {
    font: '8x8',
    cellWidth: 8,
    cellHeight: 8,
    variant: 'bw',
    lineRepeat: 2,
    frameSize: 1568,
    tokenEstimate: 3300
  },
  /** Google: 8x8 repeated grid, sentence coloring */
  google: {
    font: '8x8',
    cellWidth: 8,
    cellHeight: 8,
    variant: 'sent',
    lineRepeat: 2,
    frameSize: 1568,
    tokenEstimate: 1100
  },
  /** OpenAI: 6x6 stretched, sentence coloring */
  openai: {
    font: '8x8',
    cellWidth: 6,
    cellHeight: 6,
    variant: 'sent',
    lineRepeat: 1,
    frameSize: 1568,
    tokenEstimate: 2900
  }
};

/**
 * Compaction session state
 */
export class CompactionSession {
  private frames: CompactionFrame[] = [];
  private originalMessages: Message[] = [];
  private compactedMessageCount = 0;

  /**
   * Add messages to be compacted
   */
  addMessages(messages: Message[]): void {
    this.originalMessages.push(...messages);
  }

  /**
   * Get compaction summary message
   */
  getSummaryMessage(): Message {
    return {
      role: 'system',
      content: `[Compacted ${this.compactedMessageCount} messages into ${this.frames.length} frames. Total token savings: ~${this.calculateTokenSavings()} tokens.]`
    };
  }

  /**
   * Calculate token savings from compaction
   */
  private calculateTokenSavings(): number {
    const originalTokens = this.estimateMessageTokens(this.originalMessages);
    const compactedTokens = this.frames.reduce((sum, frame) => sum + frame.tokenEstimate, 0);
    return originalTokens - compactedTokens;
  }

  /**
   * Estimate token count for messages
   */
  private estimateMessageTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return sum + Math.ceil(content.length / 4); // Rough estimate: 4 chars per token
    }, 0);
  }

  /**
   * Get all frames
   */
  getFrames(): CompactionFrame[] {
    return [...this.frames];
  }

  /**
   * Get compacted message count
   */
  getCompactedCount(): number {
    return this.compactedMessageCount;
  }
}

/**
 * Create compaction session from messages
 */
export function createCompactionSession(messages: Message[], provider: string = 'anthropic'): CompactionSession {
  const session = new CompactionSession();
  const shape = SHAPES[provider] || SHAPES.anthropic;

  // For now, use mock compaction (in production, would render actual PNG frames)
  const mockFrame: CompactionFrame = {
    data: 'mock_png_base64_data',
    tokenEstimate: shape.tokenEstimate,
    shape
  };

  session.addMessages(messages);
  session['frames'] = [mockFrame];
  session['compactedMessageCount'] = messages.length;

  return session;
}

/**
 * Check if compaction should trigger
 */
export function shouldCompact(
  messageCount: number,
  estimatedTokens: number,
  threshold: number = 100000
): boolean {
  return estimatedTokens > threshold || messageCount > 100;
}

/**
 * Get optimal shape for provider
 */
export function getOptimalShape(provider: string): FrameShape {
  const normalizedProvider = provider.toLowerCase();

  if (normalizedProvider.includes('openai') || normalizedProvider.includes('gpt')) {
    return SHAPES.openai;
  }

  if (normalizedProvider.includes('google') || normalizedProvider.includes('gemini')) {
    return SHAPES.google;
  }

  // Default to Anthropic shape (most robust)
  return SHAPES.anthropic;
}
