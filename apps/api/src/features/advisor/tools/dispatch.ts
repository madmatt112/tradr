// Server-side tool dispatcher (design §Component 1 steps 1-8, §Error Handling).
//
// `dispatchTool` is the single authorization boundary (REQ-1.7/1.8): every
// model-emitted tool call passes through it. It performs, in order:
//
//   1. registry lookup            → TOOL_NOT_PERMITTED
//   2. re-check `requires`         → TOOL_NOT_PERMITTED
//   3. safeParse(inputSchema)      → TOOL_INPUT_INVALID (returned, never thrown)
//   4. degenerate withdrawal gate  → standing error if this tool hit K failures
//   5. trade-data PRE-CALL egress  → TRADE_DATA_BUDGET_EXCEEDED (no fetch/persist)
//   6. execute handler
//   7. degenerate / success accounting
//   8. log TOOL_NOT_PERMITTED without payload
//
// The dispatcher does NOT own timeouts or the per-tool AbortController — the loop
// (task 25) creates a per-tool controller and hands it in; `withToolTimeout`
// (task 22) aborts it. `buildToolContext` chains that controller's signal onto
// the turn-level signal so the handler reads ONE signal that fires on either a
// per-tool timeout or a client/app-timer abort (design §Component 1, supersedes
// the illustrative pseudocode at design.md:137 / :198).

import type { ZodError } from 'zod';

import { logger } from '@/lib/logger';

import { bucketOf } from './error-codes';
import { toolRegistry } from './registry';
import type {
  ToolCategory,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UnusualWhalesClient,
} from './types';

/** Per-turn cumulative trade-data egress cap, in tokens (REQ-9.5, design pin). */
export const TRADE_DATA_EGRESS_CAP = 20_000;

/** Per-tool degenerate-failure withdrawal threshold (REQ-1.9, design pin K). */
export const PER_TOOL_FAILURE_LIMIT = 3;

/**
 * Degeneracy-class codes counted toward the per-tool `K` and aggregate `M`
 * guards (design §Component 1 step 4). `SYMBOL_NOT_FOUND` and
 * `TRADE_DATA_BUDGET_EXCEEDED` are deliberately EXCLUDED — a user typo or a hit
 * egress cap is normal adaptation, not a failing tool. Repeated-identical
 * `TOOL_INPUT_INVALID` is counted; a first/distinct `TOOL_INPUT_INVALID` is not
 * (handled separately in `isDegenerateFailure`).
 */
const DEGENERACY_CLASS_CODES: ReadonlySet<string> = new Set([
  'TOOL_NOT_PERMITTED',
  'PLATFORM_RATE_LIMITED',
  'MARKET_DATA_RATE_LIMITED',
  'MARKET_DATA_UNAVAILABLE',
  'MARKET_DATA_KEY_INVALID',
  'TOOL_TIMEOUT',
]);

/**
 * A single tool call as accumulated from a provider stream (design §Component 2;
 * the adapter emits a `tool_call` event carrying these). `arguments` is the
 * already-JSON-parsed argument object the model produced; the dispatcher
 * `safeParse`s it against the tool's `inputSchema`.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * Mutable per-turn accounting threaded through every `dispatchTool` call in a
 * turn (design §Component 1/3). Created once by the loop (task 25/27) at turn
 * start and passed by reference.
 *
 * - `failByTool` — cumulative degeneracy-class failure count per tool name (K).
 * - `totalDegenerateFailures` — cumulative degeneracy-class failures across all
 *   tools (M). The loop early-aborts only when this reaches M AND
 *   `successCount === 0` (the productivity gate — design §Component 1 step 4).
 * - `successCount` — count of `ok` results this turn (productivity signal).
 * - `tradeDataTokens` — cumulative trade-data egress charged this turn.
 * - `withdrawn` — tool names withdrawn after hitting K; the loop removes these
 *   from `buildDeclarations` on the next round-trip (task 27).
 * - `lastInvalidInput` — last rejected-args serialization per tool, used to
 *   detect a REPEATED-identical `TOOL_INPUT_INVALID` (which IS degenerate).
 */
export interface TurnState {
  failByTool: Record<string, number>;
  totalDegenerateFailures: number;
  successCount: number;
  tradeDataTokens: number;
  withdrawn: Set<string>;
  lastInvalidInput: Record<string, string>;
}

/** Fresh, empty per-turn accounting (REQ-1.9, REQ-9.5). */
export function createTurnState(): TurnState {
  return {
    failByTool: {},
    totalDegenerateFailures: 0,
    successCount: 0,
    tradeDataTokens: 0,
    withdrawn: new Set<string>(),
    lastInvalidInput: {},
  };
}

/**
 * The current iteration's authorization snapshot (design §Component 1 step 2,
 * REQ-1.7). `consent` and `hasUwKey` are re-read per round-trip by the loop;
 * `caps.toolUse` is immutable within a turn.
 */
export interface DispatchSnapshot {
  toolUse: boolean;
  consent: boolean;
  hasUwKey: boolean;
}

/**
 * Per-call seams the loop supplies. The loop owns the per-tool AbortController
 * (chained by `buildToolContext` onto the turn signal) and constructs the UW
 * client for market-data tools from the current iteration's key ciphertext
 * (rebuilt per iteration — REQ-1.7 key rotation). The registry is injectable so
 * loop tests (tasks 25/27) can script results; it defaults to `toolRegistry`.
 */
export interface DispatchDeps {
  /** Turn-level signal (the loop's `timerController.signal`). */
  turnSignal: AbortSignal;
  /** Per-tool controller created by the loop; `withToolTimeout` (task 22) aborts it. */
  perToolController: AbortController;
  /** Builds a UW client bound to this user's key/meter/cache (market-data only). */
  makeUwClient?: () => UnusualWhalesClient;
  /** Injectable registry for tests; defaults to the real `toolRegistry`. */
  registry?: Readonly<Record<string, ToolDefinition>>;
}

/**
 * Build the per-call `ToolContext` (design §Component 1, REQ-1.4).
 *
 * The handler's `signal` is the per-tool AbortController's signal CHAINED onto
 * the turn-level signal: it aborts when EITHER the per-tool timeout fires
 * (`perToolController.abort()` via `withToolTimeout`, task 22) OR the turn
 * aborts (client disconnect / app timer, via `turnSignal`). So the controller
 * the loop's `withToolTimeout` owns is the SAME one whose signal the handler
 * reads — aborting it cancels a handler awaiting `ctx.signal`.
 *
 * The UW client (and thus the decrypted key) reaches ONLY market-data handlers
 * (REQ-1.4) — trade-data contexts carry no `uw`.
 */
export function buildToolContext(
  category: ToolCategory,
  base: Pick<ToolContext, 'userId' | 'conversationId'>,
  turnSignal: AbortSignal,
  perToolController: AbortController,
  makeUwClient?: () => UnusualWhalesClient,
): ToolContext {
  // Chain: if the turn aborts, also abort the per-tool controller so the
  // handler's single `ctx.signal` reflects both sources (codebase pattern —
  // streaming.ts folds combinedSignal into timerController the same way).
  if (turnSignal.aborted) {
    perToolController.abort(turnSignal.reason);
  } else {
    turnSignal.addEventListener('abort', () => perToolController.abort(turnSignal.reason), {
      once: true,
    });
  }

  const ctx: ToolContext = {
    userId: base.userId,
    conversationId: base.conversationId,
    signal: perToolController.signal,
  };
  if (category === 'market-data' && makeUwClient) {
    ctx.uw = makeUwClient();
  }
  return ctx;
}

/** Is `def.requires` satisfied by the current snapshot? (REQ-1.7, authoritative.) */
function isRequirementSatisfied(def: ToolDefinition, snapshot: DispatchSnapshot): boolean {
  switch (def.requires) {
    case 'none':
      return true;
    case 'trade-data-consent':
      return snapshot.consent;
    case 'unusual-whales-key':
      return snapshot.hasUwKey;
    default:
      return false; // unknown requirement → fail closed
  }
}

/**
 * Does an error result count toward the degenerate guards? (design §Component 1
 * step 4.) Degeneracy-class codes always count; `TOOL_INPUT_INVALID` counts only
 * when it is REPEATED-identical for the same tool; `SYMBOL_NOT_FOUND` and
 * `TRADE_DATA_BUDGET_EXCEEDED` never count.
 */
function isDegenerateFailure(
  toolName: string,
  code: string,
  argsKey: string,
  turnState: TurnState,
): boolean {
  if (DEGENERACY_CLASS_CODES.has(code)) return true;
  if (code === 'TOOL_INPUT_INVALID') {
    return turnState.lastInvalidInput[toolName] === argsKey;
  }
  return false;
}

/** Stable serialization of arguments for repeated-identical-invalid detection. */
function argsKeyOf(args: unknown): string {
  try {
    return JSON.stringify(args) ?? 'undefined';
  } catch {
    return String(args);
  }
}

/**
 * Record a degeneracy-class failure against the per-tool (K) and aggregate (M)
 * budgets, withdrawing the tool once it reaches K (design §Component 1 steps
 * 4/7). The loop owns the aggregate `M AND successCount===0` early-abort; this
 * function only maintains the counters and the `withdrawn` set.
 */
function recordDegenerateFailure(toolName: string, turnState: TurnState): void {
  turnState.failByTool[toolName] = (turnState.failByTool[toolName] ?? 0) + 1;
  turnState.totalDegenerateFailures += 1;
  if (turnState.failByTool[toolName] >= PER_TOOL_FAILURE_LIMIT) {
    turnState.withdrawn.add(toolName);
  }
}

const err = (code: string, message: string): ToolResult => ({ status: 'error', code, message });

/** Compact, model-readable summary of a Zod failure (repo `validation.ts` style). */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Dispatch a single model-emitted tool call (design §Component 1 steps 1-8,
 * REQ-1.5/1.7/1.8/1.9/9.5/15.5). Always RETURNS a `ToolResult` — never throws on
 * an invalid-input or precondition path. Handler exceptions are NOT caught here;
 * the loop's `withToolTimeout` (task 22) maps a timeout to `TOOL_TIMEOUT` and
 * other handler throws to their mapped codes.
 */
export async function dispatchTool(
  call: ToolCall,
  base: Pick<ToolContext, 'userId' | 'conversationId'>,
  snapshot: DispatchSnapshot,
  turnState: TurnState,
  deps: DispatchDeps,
): Promise<ToolResult> {
  const registry = deps.registry ?? toolRegistry;

  // Step 1: registry lookup.
  const def = registry[call.name];
  if (!def) {
    logger.warn('tool dispatch: not permitted (unknown tool)', { toolName: call.name }); // no payload (REQ-1.8)
    const result = err('TOOL_NOT_PERMITTED', 'This tool is not available.');
    recordDegenerateFailure(call.name, turnState);
    return result;
  }

  // Step 2: re-check `requires` against the current iteration snapshot (REQ-1.7).
  if (!snapshot.toolUse || !isRequirementSatisfied(def, snapshot)) {
    logger.warn('tool dispatch: not permitted (precondition unmet)', { toolName: call.name }); // no payload
    recordDegenerateFailure(call.name, turnState);
    return err('TOOL_NOT_PERMITTED', 'This tool is not available.');
  }

  // Step 3: validate arguments (REQ-1.5) — return, never throw.
  const parsed = def.inputSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const argsKey = argsKeyOf(call.arguments);
    const result = err('TOOL_INPUT_INVALID', formatZodError(parsed.error));
    // Repeated-identical invalid args are degenerate (design §Component 1 step 4).
    if (isDegenerateFailure(call.name, 'TOOL_INPUT_INVALID', argsKey, turnState)) {
      recordDegenerateFailure(call.name, turnState);
    }
    turnState.lastInvalidInput[call.name] = argsKey;
    return result;
  }

  // Step 4: degenerate withdrawal gate — a tool already at K returns its standing
  // error without executing (design §Component 1 step 4).
  if (turnState.withdrawn.has(call.name)) {
    return err('TOOL_NOT_PERMITTED', 'This tool was withdrawn after repeated failures.');
  }

  // Step 5: trade-data PRE-CALL egress cap on the STATIC worst-case bound
  // (REQ-9.5) — no fetch, no persist. NOT counted as a degenerate failure.
  if (def.category === 'trade-data') {
    const bound = def.maxEstTokens ?? 0;
    if (turnState.tradeDataTokens + bound > TRADE_DATA_EGRESS_CAP) {
      return err(
        'TRADE_DATA_BUDGET_EXCEEDED',
        'The per-turn trade-data budget for this conversation has been reached.',
      );
    }
  }

  // Step 6: execute the handler with a per-call context (UW client only for
  // market-data — REQ-1.4).
  const ctx = buildToolContext(
    def.category,
    base,
    deps.turnSignal,
    deps.perToolController,
    deps.makeUwClient,
  );
  const result = await def.handler(parsed.data, ctx);

  // Step 7: degenerate / success accounting (design §Component 1 step 7).
  if (result.status === 'ok') {
    turnState.successCount += 1;
    if (def.category === 'trade-data') {
      turnState.tradeDataTokens += def.maxEstTokens ?? 0;
    }
  } else if (isDegenerateFailure(call.name, result.code, argsKeyOf(call.arguments), turnState)) {
    recordDegenerateFailure(call.name, turnState);
  }

  // Defense-in-depth: a handler must return a `tool_result`-bucket code. A
  // misclassified code (e.g. an event:error code) is a programming error.
  if (result.status === 'error' && bucketOf(result.code) !== 'tool_result') {
    logger.error('tool handler returned a non-tool_result code', {
      toolName: call.name,
      code: result.code,
    });
  }

  return result;
}
