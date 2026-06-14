/**
 * Native Performance Optimizations Module
 * Matching oh-my-pi's Rust-based performance using Bun's capabilities
 */

export * from './optimizer';
export * from './snapcompact';
export * from './debug-bridge';

// Re-export for convenience
export { fastSearch, fastFS, fastText, FastTokens } from './optimizer';
export { snapcompactRenderer, SnapcompactSession, SHAPES } from './snapcompact';
export {
  DebugBridge,
  getDebugBridge,
  disposeDebugBridge,
  type DebugOp,
  type DebugRpcResponse,
  type DebugAdapterKind,
  type LineBreakpoint,
} from './debug-bridge';
