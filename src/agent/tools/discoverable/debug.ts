/**
 * Debug tool - real DAP (Debug Adapter Protocol) integration.
 *
 * Backed by the Rust-native `euler-debug` binary (see `native/euler-debug`),
 * which drives real adapters: debugpy (Python), lldb-dap/codelldb (C/C++/Rust),
 * dlv (Go), and node (JavaScript/TypeScript). No mocks.
 *
 * DESIGN for weak/junior models (deepseek-flash class):
 * - Each call does ONE discrete thing. There is no "operation" mega-parameter
 *   that buries required fields behind string parsing.
 * - Required fields are validated up front with actionable error messages.
 * - The canonical DAP lifecycle is enforced and surfaced: start -> launch ->
 *   setBreakpoints -> configurationDone -> threads -> stackTrace -> scopes ->
 *   variables / evaluate. Every error message names the missing precondition.
 * - Responses are kept compact and predictable so a small model can act on
 *   them without re-reading long prose.
 */

import { getDebugBridge, type DebugBridge, type LineBreakpoint } from '../../../native/debug-bridge';
import type { Tool, ToolResult } from '../types';

export const debugTool: Tool = {
  name: 'debug',
  description:
    'Real DAP debugger (drives debugpy / lldb-dap / dlv / node via the Rust euler-debug binary). ' +
    'Each call performs ONE discrete step of the DAP lifecycle: start, launch, setBreakpoints, ' +
    'configurationDone, threads, stackTrace, scopes, variables, evaluate, continue, pause, ' +
    'stepOver, stepIn, stepOut, status, disconnect. The typical order to debug a program is: ' +
    'start -> launch -> setBreakpoints -> configurationDone -> threads -> stackTrace -> scopes -> variables.',
  category: 'discoverable',
  parameters: [
    {
      name: 'op',
      type: 'string',
      description:
        'The single operation to perform. One of: start, launch, setBreakpoints, configurationDone, ' +
        'threads, stackTrace, scopes, variables, evaluate, continue, pause, stepOver, stepIn, stepOut, ' +
        'status, disconnect.',
      required: true,
    },
    {
      name: 'target',
      type: 'string',
      description: 'For "start": the file/program to debug (used to detect the adapter).',
      required: false,
    },
    {
      name: 'adapter',
      type: 'string',
      description: 'For "start": force an adapter. One of: python, lldb, go, node. Default: infer from target.',
      required: false,
    },
    {
      name: 'program',
      type: 'string',
      description: 'For "launch": the program path to run.',
      required: false,
    },
    {
      name: 'args',
      type: 'array',
      description: 'For "launch": program arguments (array of strings).',
      required: false,
    },
    {
      name: 'pid',
      type: 'number',
      description: 'For "attach": the process ID to attach to.',
      required: false,
    },
    {
      name: 'source',
      type: 'string',
      description: 'For "setBreakpoints": the source file path.',
      required: false,
    },
    {
      name: 'breakpoints',
      type: 'array',
      description: 'For "setBreakpoints": array of { line: number, condition?: string }.',
      required: false,
    },
    {
      name: 'threadId',
      type: 'number',
      description: 'Thread ID for: stackTrace, continue, pause, stepOver, stepIn, stepOut.',
      required: false,
    },
    {
      name: 'frameId',
      type: 'number',
      description: 'Frame ID for: scopes, evaluate.',
      required: false,
    },
    {
      name: 'variablesReference',
      type: 'number',
      description: 'For "variables": a variablesReference returned by scopes or another variables call.',
      required: false,
    },
    {
      name: 'expression',
      type: 'string',
      description: 'For "evaluate": the expression to evaluate in the current frame.',
      required: false,
    },
    {
      name: 'terminate',
      type: 'boolean',
      description: 'For "disconnect": whether to terminate the debuggee (default: true).',
      required: false,
      default: true,
    },
  ],
  examples: [
    {
      input: { op: 'start', target: 'app.py' },
      output: { started: true, adapter: 'python', state: 'initialized' },
      description: 'Start the debugger adapter for a Python program.',
    },
    {
      input: { op: 'setBreakpoints', source: 'app.py', breakpoints: [{ line: 42 }] },
      output: { breakpoints: [{ verified: true, line: 42 }] },
      description: 'Set a breakpoint on line 42.',
    },
    {
      input: { op: 'evaluate', expression: 'x + y', frameId: 1 },
      output: { result: { name: 'x + y', value: '42', variablesReference: 0 } },
      description: 'Evaluate an expression in a frame.',
    },
  ],
  handler: async (input: Record<string, any>): Promise<ToolResult> => {
    try {
      const { op } = input;
      if (typeof op !== 'string' || op.length === 0) {
        return {
          success: false,
          error:
            "Missing required parameter 'op'. Valid ops: start, launch, setBreakpoints, " +
            'configurationDone, threads, stackTrace, scopes, variables, evaluate, continue, ' +
            'pause, stepOver, stepIn, stepOut, status, disconnect.',
        };
      }

      const bridge: DebugBridge = getDebugBridge();
      const req = buildRequest(op, input);
      if ('error' in req) {
        return { success: false, error: req.error };
      }

      const result = await bridge.request(req as any, requestTimeoutFor(op));
      return { success: true, data: result };
    } catch (error: any) {
      // The bridge throws on RPC failure or timeout; surface the message
      // verbatim because it already names the missing precondition.
      return { success: false, error: error?.message ?? String(error) };
    }
  },
};

/**
 * Translate the flat tool input into the typed RPC request the binary expects.
 * Returns `{ error }` for invalid input so the handler can fail fast with a
 * junior-friendly message that names exactly what is missing.
 */
function buildRequest(
  op: string,
  input: Record<string, any>,
):
  | { error: string }
  | { [k: string]: unknown } {
  switch (op) {
    case 'start': {
      const target = checkString(input, 'target', op);
      if (target === null) {
        return { error: `op '${op}' requires a non-empty string parameter 'target'.` };
      }
      return { op, target, adapter: input.adapter };
    }
    case 'launch': {
      const program = checkString(input, 'program', op);
      if (program === null) {
        return { error: `op '${op}' requires a non-empty string parameter 'program'.` };
      }
      return { op, program, args: Array.isArray(input.args) ? input.args : [] };
    }
    case 'attach': {
      const pid = checkNumber(input, 'pid', op);
      if (pid === null) {
        return { error: `op '${op}' requires a finite number parameter 'pid'.` };
      }
      return { op, pid };
    }
    case 'setBreakpoints': {
      const source = checkString(input, 'source', op);
      if (source === null) {
        return { error: `op '${op}' requires a non-empty string parameter 'source'.` };
      }
      const raw = input.breakpoints;
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          error:
            "'setBreakpoints' requires 'breakpoints' as a non-empty array of " +
            "{ line: number, condition?: string }. Got: " +
            JSON.stringify(raw),
        };
      }
      const breakpoints: LineBreakpoint[] = [];
      for (let i = 0; i < raw.length; i++) {
        const bp = raw[i];
        if (typeof bp !== 'object' || bp === null || typeof bp.line !== 'number') {
          return {
            error: `breakpoints[${i}] must be { line: number, condition?: string }; got ${JSON.stringify(bp)}`,
          };
        }
        const item: LineBreakpoint = { line: bp.line };
        if (typeof bp.condition === 'string' && bp.condition.length > 0) {
          item.condition = bp.condition;
        }
        breakpoints.push(item);
      }
      return { op, source, breakpoints };
    }
    case 'configurationDone':
    case 'threads':
    case 'status':
      return { op };

    case 'disconnect':
      return { op, terminate: input.terminate !== false };

    case 'stackTrace':
    case 'continue':
    case 'pause':
    case 'stepOver':
    case 'stepIn':
    case 'stepOut': {
      const threadId = checkNumber(input, 'threadId', op);
      if (threadId === null) {
        return { error: `op '${op}' requires a finite number parameter 'threadId'.` };
      }
      return { op, threadId };
    }
    case 'scopes': {
      const frameId = checkNumber(input, 'frameId', op);
      if (frameId === null) {
        return { error: `op '${op}' requires a finite number parameter 'frameId'.` };
      }
      return { op, frameId };
    }
    case 'variables': {
      const variablesReference = checkNumber(input, 'variablesReference', op);
      if (variablesReference === null) {
        return { error: `op '${op}' requires a finite number parameter 'variablesReference'.` };
      }
      return { op, variablesReference };
    }
    case 'evaluate': {
      const expression = checkString(input, 'expression', op);
      if (expression === null) {
        return { error: `op '${op}' requires a non-empty string parameter 'expression'.` };
      }
      const req: Record<string, unknown> = { op, expression };
      if (typeof input.frameId === 'number') req.frameId = input.frameId;
      return req;
    }
    default:
      return {
        error:
          `Unknown op '${op}'. Valid ops: start, launch, setBreakpoints, configurationDone, ` +
          'threads, stackTrace, scopes, variables, evaluate, continue, pause, stepOver, ' +
          'stepIn, stepOut, status, disconnect.',
      };
  }
}

/** Returns the value as a non-empty string, or `null` if invalid. */
function checkString(input: Record<string, any>, key: string): string | null {
  const v = input[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/** Returns the value as a finite number, or `null` if invalid. */
function checkNumber(input: Record<string, any>, key: string): number | null {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Allow longer timeouts for slow lifecycle ops (launch can spawn a process). */
function requestTimeoutFor(op: string): number {
  switch (op) {
    case 'start':
    case 'launch':
    case 'attach':
      return 60_000;
    default:
      return 30_000;
  }
}
