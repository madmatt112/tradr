// Per-tool timeout wrapper for the agentic loop (design §Component 1, REQ-3.6/3.4).
//
// SUPERSEDES the illustrative pseudocode at design.md:198
// (`withToolTimeout(dispatchTool(...), ms)` — an eager, already-started promise
// with no controller). That shape cannot cancel an in-flight handler: by the
// time the wrapper sees a timeout the handler is already running against a
// signal the wrapper does not control. THIS implementation instead takes
// `run(signal)` and OWNS (or is handed, task 25) the per-tool `AbortController`
// whose signal backs `ctx.signal` (threaded by `buildToolContext`, task 6). On
// timeout it ABORTS that controller — cancelling the in-flight handler AND its
// Unusual Whales socket — then returns a `TOOL_TIMEOUT` `tool_result` so the
// loop CONTINUES (REQ-15.1, tool_result bucket). The handler reads ONE signal
// that fires on either the per-tool timeout or a turn-level abort.

import { TOOL_RESULT_CODES } from '../tools/error-codes';
import type { ToolResult } from '../tools/types';

/** Per-tool timeout, in milliseconds (REQ-3.6, design pin). */
export const PER_TOOL_TIMEOUT_MS = 15_000;

/**
 * Run a tool handler under a per-tool timeout (REQ-3.6, REQ-3.4).
 *
 * `run(signal)` is invoked with `perToolController.signal` — NOT a pre-started
 * promise — so the controller this helper aborts is the SAME one whose signal
 * the handler reads (via `ctx.signal`). On timeout the controller is aborted
 * (cancelling the in-flight handler + its UW socket) and a `TOOL_TIMEOUT`
 * `tool_result` is returned so the loop continues. The timer is cleared in
 * every path (success, error, timeout).
 *
 * @param run                The handler runner; receives the abort signal.
 * @param ms                 Timeout budget; defaults to `PER_TOOL_TIMEOUT_MS`.
 * @param perToolController  The per-tool controller backing `ctx.signal`; one
 *                           is created here if the loop does not supply it.
 */
export async function withToolTimeout(
  run: (signal: AbortSignal) => Promise<ToolResult>,
  ms: number = PER_TOOL_TIMEOUT_MS,
  perToolController: AbortController = new AbortController(),
): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutResult: ToolResult = {
    status: 'error',
    code: TOOL_RESULT_CODES.TOOL_TIMEOUT,
    message: `Tool exceeded the ${ms}ms per-tool timeout.`,
  };

  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Abort the SAME controller backing ctx.signal: cancels the in-flight
      // handler and its Unusual Whales socket (REQ-3.4).
      perToolController.abort();
      resolve(timeoutResult);
    }, ms);
  });

  try {
    const result = await Promise.race([run(perToolController.signal), timeout]);
    // Once the timeout fired the tool is timed out, period — even if the
    // handler raced in a value as it was being aborted, the loop must see
    // TOOL_TIMEOUT (REQ-3.6).
    return timedOut ? timeoutResult : result;
  } finally {
    // Clean up the timer in every path (success / error / timeout). Only the
    // timeout path aborts the controller; a fast handler leaves it untouched.
    if (timer !== undefined) clearTimeout(timer);
  }
}
