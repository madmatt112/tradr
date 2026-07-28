/**
 * Scriptable fake `ProviderAdapter` for the agentic-loop tests (Task 24).
 *
 * There is NO runtime production injection seam for the provider: `getProvider`
 * / the `registry` map in `providers/registry.ts` are module-private and built
 * once at bootstrap. So loop tests consume this fixture by MODULE-MOCKING the
 * registry — the established pattern in `streaming.test.ts:49-55`:
 *
 *   import { makeScriptedProvider, type ProviderScript } from './__fixtures__/scriptable-provider';
 *   const provider = makeScriptedProvider({ ... });
 *   vi.mock('./providers/registry', () => ({ getProvider: () => provider }));
 *
 * The fixture is PER-ITERATION scriptable: each call to `streamChat` consumes
 * the next entry in the `iterations` array and yields exactly that entry's
 * programmed sequence of `ProviderStreamEvent`s (`token` / `tool_call` /
 * `usage`), always terminated by a `done` event. This lets a test force, e.g.,
 * "request tools on all 6 iterations" or "tool_calls then final text".
 *
 * _Requirements: REQ-3.2, REQ-1.9 (testability enablement)_
 */
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderModel,
  ProviderStreamArgs,
  ProviderStreamEvent,
} from '../providers/adapter';

/**
 * The programmed event sequence for one provider round-trip (one loop
 * iteration). The fixture appends a trailing `{ type: 'done' }` automatically,
 * so a script need not (and should not) include it.
 */
export type IterationScript = ProviderStreamEvent[];

export interface ProviderScript {
  /**
   * One entry per loop iteration, consumed in order. The Nth `streamChat` call
   * yields `iterations[N]`'s events. Calling `streamChat` more times than there
   * are entries throws (a test asked for more round-trips than it scripted).
   */
  iterations: IterationScript[];
  /** Optional model id reported by the adapter; defaults to 'claude-test'. */
  id?: 'claude' | 'openai' | 'gemini' | 'openrouter';
}

export interface ScriptedProvider extends ProviderAdapter {
  /** Number of times `streamChat` has been invoked (= iterations consumed). */
  readonly callCount: number;
  /** The `tools` argument passed to each `streamChat` call, in order. */
  readonly toolsPerCall: ReadonlyArray<ProviderStreamArgs['tools']>;
}

/**
 * A small helper for the common case: yield `count` tool-call requests, one per
 * iteration, all naming the same tool. Each iteration emits a single `tool_call`
 * event (id `tc-<n>`).
 */
export function toolCallEveryIteration(
  count: number,
  toolName: string,
  args: unknown = {},
): IterationScript[] {
  return Array.from({ length: count }, (_v, i) => [
    { type: 'tool_call', id: `tc-${i}`, name: toolName, arguments: args } as ProviderStreamEvent,
  ]);
}

/**
 * Build a scriptable fake `ProviderAdapter`. Only `streamChat`, `translate`,
 * and `id` are meaningfully exercised by the loop; `listModels` /
 * `prepareForTokenCount` are stubs that throw if a test wires a path that
 * reaches them (so misuse surfaces loudly).
 */
export function makeScriptedProvider(script: ProviderScript): ScriptedProvider {
  let callIndex = 0;
  const toolsPerCall: Array<ProviderStreamArgs['tools']> = [];

  const provider: ScriptedProvider = {
    id: script.id ?? 'claude',
    get callCount() {
      return callIndex;
    },
    get toolsPerCall() {
      return toolsPerCall;
    },
    listModels(): Promise<ProviderModel[]> {
      throw new Error('scriptable-provider: listModels is not scripted');
    },
    translate(list: CanonicalMessage[]): unknown {
      // Identity passthrough — the loop treats translated messages as opaque.
      return list;
    },
    prepareForTokenCount(): unknown {
      throw new Error('scriptable-provider: prepareForTokenCount is not scripted');
    },
    streamChat(args: ProviderStreamArgs): AsyncIterable<ProviderStreamEvent> {
      const i = callIndex++;
      const events = script.iterations[i];
      toolsPerCall.push(args.tools);
      if (events === undefined) {
        throw new Error(
          `scriptable-provider: streamChat called ${callIndex} time(s) but only ` +
            `${script.iterations.length} iteration(s) scripted`,
        );
      }
      return (async function* gen() {
        for (const event of events) {
          yield event;
        }
        yield { type: 'done' };
      })();
    },
  };

  return provider;
}
