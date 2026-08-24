import { create } from 'zustand';

/**
 * Placeholder conversation id for the first turn of a new conversation. The
 * server creates the row while persisting that turn, so the stream runs — and
 * the store entry lives — under this key until the real id is known, then
 * `adopt` carries it over.
 */
export const NEW_CONVERSATION_ID = 'new';

// v4-4: per-conversation in-flight assistant text lives in a flat Record (NOT a Map),
// and appendToken mutates via a single-key spread. v4-9 pins the concrete semantics for
// setError, setDone, and reset.
export type StreamState =
  | { kind: 'idle' }
  // submitted, no frame from the server yet — the transcript shows a thinking
  // indicator so the user sees the turn was accepted before the first token
  | { kind: 'pending' }
  | { kind: 'streaming'; text: string }
  // text retained until the query cache has the persisted message with this messageId
  | { kind: 'done'; text: string; messageId: string }
  // text is the partial streamed output; the retry button is rendered alongside errorCode
  | { kind: 'error'; text: string; errorCode: string };

// Per-conversation tool activity for the in-flight transcript affordance
// (REQ-5.5 / §Component 11). `tool_call` appends a pending entry; the matching
// `tool_result` (by toolCallId) resolves it. Cleared on reset alongside text.
export interface ToolActivity {
  id: string;
  name: string;
  argumentsPreview: string;
  status: 'pending' | 'ok' | 'error';
  summary?: string;
}

// Per-conversation billing-mode disclosure for the in-flight turn, surfaced from
// the server's `BILLING_MODE` notice frame (wallet-billing REQ-6.5). `fellThrough`
// flags a was-BYOK→platform fall-through. Cleared on reset alongside text.
export interface BillingMode {
  mode: 'platform' | 'byok';
  fellThrough?: boolean;
}

// The user's own message for the in-flight turn, rendered optimistically the
// instant it is submitted. Persisted messages only reach the query cache after
// the turn commits, so without this the sent text vanishes from the composer
// and reappears (with the reply) seconds later. Cleared on reset alongside text.
export interface PendingUserMessage {
  clientMessageId: string;
  text: string;
  attachments: { format: 'png' | 'jpeg' | 'webp'; dataBase64: string }[];
}

export interface StreamStore {
  byConversation: Record<string, StreamState>;
  toolsByConversation: Record<string, ToolActivity[]>;
  billingModeByConversation: Record<string, BillingMode>;
  userMessageByConversation: Record<string, PendingUserMessage>;
  start: (conversationId: string, userMessage: PendingUserMessage) => void;
  adopt: (fromId: string, toId: string) => void;
  appendToken: (conversationId: string, delta: string) => void;
  addToolCall: (
    conversationId: string,
    call: { id: string; name: string; argumentsPreview: string },
  ) => void;
  addToolResult: (
    conversationId: string,
    result: { toolCallId: string; status: 'ok' | 'error'; summary: string },
  ) => void;
  setBillingMode: (conversationId: string, billingMode: BillingMode) => void;
  setError: (conversationId: string, errorCode: string) => void;
  setDone: (conversationId: string, messageId: string) => void;
  reset: (conversationId: string) => void;
}

export const useStreamStore = create<StreamStore>((set) => ({
  byConversation: {},
  toolsByConversation: {},
  billingModeByConversation: {},
  userMessageByConversation: {},

  // Marks a submission as in flight: clears the previous turn's entry for this
  // conversation (as reset does), records the user's message for optimistic
  // rendering, and puts the slice in `pending` until the first frame arrives.
  start: (id, userMessage) =>
    set((s) => {
      const cleared = omitConversation(s, id);
      return {
        ...cleared,
        byConversation: { ...cleared.byConversation, [id]: { kind: 'pending' } },
        userMessageByConversation: { ...cleared.userMessageByConversation, [id]: userMessage },
      };
    }),

  // Copies one conversation's slices under another key. The new-conversation
  // flow streams under the `new` placeholder id and only learns the server id
  // at the end; adopting the entry under that id lets the transcript at
  // /advisor/{id} keep showing the finished turn until the persisted messages
  // load. The source entry is left in place — the page clears it once it is
  // rendering a real conversation.
  adopt: (fromId, toId) =>
    set((s) => {
      const state = s.byConversation[fromId];
      if (!state) return {};
      const tools = s.toolsByConversation[fromId];
      const mode = s.billingModeByConversation[fromId];
      const userMessage = s.userMessageByConversation[fromId];
      return {
        byConversation: { ...s.byConversation, [toId]: state },
        toolsByConversation: tools
          ? { ...s.toolsByConversation, [toId]: tools }
          : s.toolsByConversation,
        billingModeByConversation: mode
          ? { ...s.billingModeByConversation, [toId]: mode }
          : s.billingModeByConversation,
        userMessageByConversation: userMessage
          ? { ...s.userMessageByConversation, [toId]: userMessage }
          : s.userMessageByConversation,
      };
    }),

  // v4-4: single-key spread. O(N) per token in the number of open conversations; for the
  // expected workload (N <= 20) sub-millisecond per token at 50 Hz token frequency.
  appendToken: (id, delta) =>
    set((s) => {
      const prev = s.byConversation[id];
      const prevText = prev?.kind === 'streaming' ? prev.text : '';
      return {
        byConversation: {
          ...s.byConversation,
          [id]: { kind: 'streaming', text: prevText + delta },
        },
      };
    }),

  // Appends a pending tool entry for the in-flight "Calling {tool}…" affordance.
  addToolCall: (id, call) =>
    set((s) => ({
      toolsByConversation: {
        ...s.toolsByConversation,
        [id]: [...(s.toolsByConversation[id] ?? []), { ...call, status: 'pending' }],
      },
    })),

  // Resolves the matching pending entry (by toolCallId) with its outcome.
  addToolResult: (id, result) =>
    set((s) => {
      const prev = s.toolsByConversation[id] ?? [];
      const next = prev.map((t) =>
        t.id === result.toolCallId && t.status === 'pending'
          ? { ...t, status: result.status, summary: result.summary }
          : t,
      );
      return { toolsByConversation: { ...s.toolsByConversation, [id]: next } };
    }),

  // Records the turn's billing-mode disclosure (BILLING_MODE notice frame).
  setBillingMode: (id, billingMode) =>
    set((s) => ({
      billingModeByConversation: { ...s.billingModeByConversation, [id]: billingMode },
    })),

  // v4-9: keeps the partial streamed text visible and records the error code.
  setError: (id, errorCode) =>
    set((s) => {
      const prev = s.byConversation[id];
      const prevText = prev?.kind === 'streaming' ? prev.text : '';
      return {
        byConversation: { ...s.byConversation, [id]: { kind: 'error', text: prevText, errorCode } },
      };
    }),

  // v4-9: records messageId so the Transcript can hand off from streamed text to
  // persisted text once TanStack Query has the message. No flash of empty content.
  setDone: (id, messageId) =>
    set((s) => {
      const prev = s.byConversation[id];
      const prevText = prev?.kind === 'streaming' ? prev.text : '';
      return {
        byConversation: { ...s.byConversation, [id]: { kind: 'done', text: prevText, messageId } },
      };
    }),

  // v4-9: clears any prior error/done placeholder for THIS conversation. Called by
  // useAdvisorStream (via start) at the start of each submission (before the SSE
  // open). Does NOT touch persisted messages (those live in TanStack Query).
  reset: (id) => set((s) => omitConversation(s, id)),
}));

// Drops every per-conversation slice for `id`, leaving the other conversations
// untouched.
function omitConversation(
  s: StreamStore,
  id: string,
): Pick<
  StreamStore,
  | 'byConversation'
  | 'toolsByConversation'
  | 'billingModeByConversation'
  | 'userMessageByConversation'
> {
  /* eslint-disable @typescript-eslint/no-unused-vars -- destructure-omit: drop this id's entry, keep the rest */
  const { [id]: _state, ...byConversation } = s.byConversation;
  const { [id]: _tools, ...toolsByConversation } = s.toolsByConversation;
  const { [id]: _mode, ...billingModeByConversation } = s.billingModeByConversation;
  const { [id]: _user, ...userMessageByConversation } = s.userMessageByConversation;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return {
    byConversation,
    toolsByConversation,
    billingModeByConversation,
    userMessageByConversation,
  };
}
