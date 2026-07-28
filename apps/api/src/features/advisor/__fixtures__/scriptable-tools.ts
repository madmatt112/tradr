/**
 * Scriptable tool double / dispatch fixture for the agentic-loop tests (Task 24).
 *
 * Builds on the `scriptedTool` fixture pattern from `tools/dispatch.test.ts`
 * (task 6), but drives results per `(toolName, callIndex)` so a loop test can
 * force degenerate/success sequences across MULTIPLE tools at once — e.g.
 * "tool A → MARKET_DATA_UNAVAILABLE on calls 1-3, tool B → ok".
 *
 * Two layers are provided:
 *   - `makeScriptedTool` — a single `ToolDefinition` whose handler returns the
 *     programmed `ToolResult` for its own call index (1:1 with task 6).
 *   - `makeScriptedRegistry` — a registry built from a per-tool result map,
 *     suitable for `dispatchTool`'s injectable `registry` dep. Returns the
 *     registry plus a `callIndexOf(name)` inspector so the self-test can assert
 *     how many times each tool ran.
 *
 * The handler records each `ctx.signal` it received (per tool) so the
 * per-tool-abort assertions in tasks 25/27 can observe cancellation.
 *
 * _Requirements: REQ-3.2, REQ-1.9 (testability enablement)_
 */
import { z } from 'zod';

import type { ToolCategory, ToolContext, ToolDefinition, ToolResult } from '../tools/types';

/** Convenience builder for an `error` ToolResult carrying a REQ-15 code. */
export function errResult(code: string, message = code): ToolResult {
  return { status: 'error', code, message };
}

/** Convenience builder for an `ok` ToolResult. */
export function okResult(content: unknown = null): ToolResult {
  return { status: 'ok', content };
}

export interface ScriptedToolSpec {
  /** Defaults to a market-data tool requiring a UW key. */
  category?: ToolCategory;
  requires?: ToolDefinition['requires'];
  inputSchema?: z.ZodType;
  maxEstTokens?: number;
  /**
   * Programmed results, consumed by call index. Past the end of the array the
   * handler returns a default `ok` result (matching task 6's `scriptedTool`).
   */
  results: ToolResult[];
}

export interface ScriptedTool {
  def: ToolDefinition;
  /** Per-call `ctx.signal`s the handler observed, in order. */
  readonly signals: ReadonlyArray<AbortSignal>;
  /** Number of times the handler has executed. */
  readonly callIndex: number;
}

/**
 * Build a single scripted `ToolDefinition` whose handler returns
 * `spec.results[callIndex]` (falling back to `ok` past the end).
 */
export function makeScriptedTool(name: string, spec: ScriptedToolSpec): ScriptedTool {
  let callIndex = 0;
  const signals: AbortSignal[] = [];

  const def: ToolDefinition = {
    name,
    description: `scripted ${name}`,
    category: spec.category ?? 'market-data',
    requires: spec.requires ?? 'unusual-whales-key',
    inputSchema: spec.inputSchema ?? z.object({ symbol: z.string() }),
    ...(spec.maxEstTokens !== undefined ? { maxEstTokens: spec.maxEstTokens } : {}),
    handler: async (_input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      signals.push(ctx.signal);
      const i = callIndex++;
      return spec.results[i] ?? okResult();
    },
  };

  return {
    def,
    get signals() {
      return signals;
    },
    get callIndex() {
      return callIndex;
    },
  };
}

export interface ScriptedRegistry {
  /** Inject as `DispatchDeps.registry`. Keyed by tool name. */
  registry: Readonly<Record<string, ToolDefinition>>;
  /** How many times the named tool's handler has executed. */
  callIndexOf(name: string): number;
  /** Per-call `ctx.signal`s the named tool observed. */
  signalsOf(name: string): ReadonlyArray<AbortSignal>;
}

/**
 * Build a registry from a per-tool spec map. Each entry's results are driven by
 * that tool's own call index, so independent per-tool sequences compose:
 *
 *   makeScriptedRegistry({
 *     tool_a: { results: [err, err, err] },
 *     tool_b: { results: [ok] },
 *   })
 */
export function makeScriptedRegistry(specs: Record<string, ScriptedToolSpec>): ScriptedRegistry {
  const tools = new Map<string, ScriptedTool>();
  for (const [name, spec] of Object.entries(specs)) {
    tools.set(name, makeScriptedTool(name, spec));
  }

  const registry = Object.fromEntries([...tools.entries()].map(([name, t]) => [name, t.def]));

  return {
    registry,
    callIndexOf(name) {
      const t = tools.get(name);
      if (!t) throw new Error(`scriptable-tools: no scripted tool named ${name}`);
      return t.callIndex;
    },
    signalsOf(name) {
      const t = tools.get(name);
      if (!t) throw new Error(`scriptable-tools: no scripted tool named ${name}`);
      return t.signals;
    },
  };
}
