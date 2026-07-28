import type { CanonicalMessage, CanonicalPart } from '@tradr/shared';

/**
 * Inputs to {@link assembleCanonicalMessages}.
 *
 * Per design.md §REQ-9.1 v4 / §Component 3 step 7. This pure function builds
 * the provider-agnostic canonical message list that both the chat-call
 * (`adapter.translate`) and the cap-check (`adapter.prepareForTokenCount`)
 * start from, so the two paths cannot drift.
 */
export interface AssembleArgs {
  /**
   * Prior conversation turns in chronological order. Each entry is already a
   * `user` or `assistant` message; a `system` entry here would be invalid and
   * the system message is owned solely by `persona` below.
   */
  history: ReadonlyArray<
    | { role: 'user'; parts: readonly CanonicalPart[] }
    | { role: 'assistant'; parts: readonly CanonicalPart[] }
  >;
  /**
   * The resolved persona, or `null` when no persona applies. When `null`, NO
   * persona system message is emitted (design.md restriction).
   */
  persona: { systemPrompt: string } | null;
  /**
   * The conversation summary, or `null` when none exists (design.md §Component
   * 8 / REQ-11.3). When present, it is emitted as a `system` message ahead of
   * the verbatim history window. `prose` is the general narrative; the optional
   * `tradeDataFigures` holds structurally-separated figures (REQ-9.6) appended
   * to the summary text when present.
   */
  summary?: { prose: string; tradeDataFigures?: string | null } | null;
  /** Parts of the new user message being submitted. */
  newMessage: readonly CanonicalPart[];
}

/**
 * Build the canonical message list: an optional leading persona `system`
 * message (only when a persona is present), then an optional summary `system`
 * message (only when a summary is present, §Component 8 / REQ-11.3), followed
 * by the verbatim history window, followed by the new user message.
 *
 * `tool_call` / `tool_result` parts pass through unchanged via the same
 * per-part spread used for text/image parts (REQ-4.4) — no shape change.
 *
 * Pure: inputs are never mutated and a fresh array is returned.
 */
export function assembleCanonicalMessages(args: AssembleArgs): CanonicalMessage[] {
  const { history, persona, summary, newMessage } = args;

  const messages: CanonicalMessage[] = [];

  if (persona !== null) {
    messages.push({ role: 'system', content: persona.systemPrompt });
  }

  if (summary != null) {
    const figures =
      summary.tradeDataFigures != null && summary.tradeDataFigures.length > 0
        ? `\n\n${summary.tradeDataFigures}`
        : '';
    messages.push({ role: 'system', content: `${summary.prose}${figures}` });
  }

  for (const turn of history) {
    messages.push({ role: turn.role, parts: [...turn.parts] });
  }

  messages.push({ role: 'user', parts: [...newMessage] });

  return messages;
}
