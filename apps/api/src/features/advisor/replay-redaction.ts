// Consent-revocation redaction at the provider-history boundary (design
// §Component 7, REQ-9.6 / REQ-9.9).
//
// On a conversation where trade-data consent has been REVOKED, persisted
// `tool_result` parts must not be replayed to the provider. This module strips
// them from a provider-bound history, replacing each with a fixed text marker.
//
// Critical scope (REQ-14.5): this is applied ONLY when assembling provider
// history (replay + the summary-call input). It is NEVER applied on the render
// path — the persisted snapshot is preserved and shown to the user; only the
// outbound provider copy is redacted. Revocation does not delete data; the only
// clean purge is deleting the conversation (REQ-9.8).
//
// Channel coverage (REQ-9.9): (a) `tool_result` parts are machine-redacted
// here; (b) because the summarizer is fed THIS redacted history, it never sees
// the trade-data figures and so cannot emit `tradeDataFigures` — the summary
// figures are omitted with no extra LLM call, and extend-prior likewise feeds
// prior PROSE only; (c) assistant free-text prose restating figures is not
// machine-coverable — disclosed, delete-only — and intentionally untouched.

/** Replaces a revoked `tool_result` part's content in the provider replay. */
export const REVOKED_TOOL_RESULT_TEXT = '[trade data hidden — consent revoked]';

/** Minimal structural shape of a message part (matches `CanonicalPart`). */
type PartLike = { readonly type: string; readonly [k: string]: unknown };

/** Minimal structural shape of a history message. */
interface MessageLike {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly PartLike[];
}

/**
 * Redact `tool_result` parts from a provider-bound history.
 *
 * - `consent === true`: returns `history` unchanged (identity).
 * - `consent === false`: every `tool_result` part is replaced with a `text`
 *   part carrying {@link REVOKED_TOOL_RESULT_TEXT}. All other parts (text,
 *   image, tool_call) pass through unchanged. Pure / no I/O / no LLM call.
 *
 * Generic over the concrete message type so callers keep their narrower
 * `StreamHistory` typing while reusing this logic.
 */
export function redactRevokedToolResults<H extends MessageLike>(
  history: readonly H[],
  consent: boolean,
): readonly H[] {
  if (consent) return history;

  return history.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_result') return part;
      changed = true;
      return { type: 'text', text: REVOKED_TOOL_RESULT_TEXT } as PartLike;
    });
    return changed ? ({ ...message, parts } as H) : message;
  });
}

/**
 * Bounded one-line summary of a value for the flattened tool marker. Mirrors the
 * SSE-preview intent: a short, lossy hint, not the full payload.
 */
function flattenSummary(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    s = String(value);
  }
  const MAX = 200;
  return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
}

/**
 * Flatten an assistant message's `tool_call` / `tool_result` parts INTO that
 * same message's text for a conversation-only (non-tool) provider call
 * (design §Component 10, REQ-13.3).
 *
 * - `toolUse === true`: returns `history` unchanged by reference (identity) —
 *   tool-capable models replay the structured parts as-is.
 * - `toolUse === false`: for each assistant message that carries `tool_call`
 *   and/or `tool_result` parts, those parts are removed and replaced by a single
 *   trailing `text` part of lines `[tool {name} → {summary}]` (one per
 *   `tool_call`, with its paired `tool_result` content as the summary). Plain
 *   `text` / `image` parts pass through unchanged and keep their order; the
 *   flattened line is appended after the message's existing parts.
 *
 * Because tool parts already live INSIDE the assistant message (there are no
 * separate `'tool'` rows), this produces NO new messages and CANNOT break
 * role alternation (REQ-13.3 restriction).
 *
 * MUST run AFTER {@link redactRevokedToolResults} on the provider path
 * (ordering pinned, §C7): a revoked `tool_result` has already become the fixed
 * marker text by the time this sees it, so no figure can leak through the
 * flattened summary.
 *
 * Pure / no I/O / no mutation of the input. Generic over the concrete message
 * type so callers keep their narrower `StreamHistory` typing.
 */
export function flattenToolPartsForNonToolModel<H extends MessageLike>(
  history: readonly H[],
  toolUse: boolean,
): readonly H[] {
  if (toolUse) return history;

  return history.map((message) => {
    const hasToolParts = message.parts.some(
      (p) => p.type === 'tool_call' || p.type === 'tool_result',
    );
    if (!hasToolParts) return message;

    // Pair each tool_result to its tool_call by id for the summary text.
    const resultByCallId = new Map<string, PartLike>();
    for (const part of message.parts) {
      if (part.type === 'tool_result' && typeof part.toolCallId === 'string') {
        resultByCallId.set(part.toolCallId, part);
      }
    }

    const lines: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      const name = typeof part.name === 'string' ? part.name : 'tool';
      const id = typeof part.id === 'string' ? part.id : undefined;
      const result = id != null ? resultByCallId.get(id) : undefined;
      const summary = result != null ? flattenSummary(result.content) : '(no result)';
      lines.push(`[tool ${name} → ${summary}]`);
    }

    const keptParts = message.parts.filter(
      (p) => p.type !== 'tool_call' && p.type !== 'tool_result',
    );
    const flattenedText: PartLike = { type: 'text', text: lines.join('\n') };

    return { ...message, parts: [...keptParts, flattenedText] } as H;
  });
}

/** Minimal structural shape of a summary carrying separated trade-data figures. */
type SummaryLike = {
  readonly prose: string;
  readonly tradeDataFigures?: string | null;
  readonly [k: string]: unknown;
};

/**
 * Redact an existing summary's separated trade-data figures at the provider
 * boundary (REQ-9.6 / REQ-9.9, channel (b)).
 *
 * - `consent === true`: returns `summary` unchanged (identity).
 * - `consent === false`: returns a shallow copy with `tradeDataFigures`
 *   omitted — prose only, NO LLM call. The figures structurally cannot reach
 *   the provider on a revoked conversation.
 * - `null`/`undefined` summary: returned unchanged (the common current path).
 *
 * Pure / no I/O / no mutation of the input. Generic over the concrete summary
 * type so callers keep their narrower typing while reusing this logic.
 */
export function redactSummaryForProvider<S extends SummaryLike>(
  summary: S | null | undefined,
  consent: boolean,
): S | null | undefined {
  if (summary == null) return summary;
  if (consent) return summary;
  return { ...summary, tradeDataFigures: undefined } as unknown as S;
}
