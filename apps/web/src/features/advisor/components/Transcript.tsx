// Transcript — the message log for one conversation (REQ-1.7, REQ-1.13, REQ-14).
//
// Persisted messages come from TanStack Query (`useConversation`). The in-flight
// assistant reply comes from the Zustand stream store, subscribed via a NARROW
// per-conversation selector wrapped in `useShallow` (design v3-9 / v4-9) so a
// token append re-renders only this component, never the whole page, and never
// on a sibling conversation's token.
//
// Handoff (design v4-9): while the store slice is `streaming`/`error`, or `done`
// but the persisted message with the recorded `messageId` is not yet in the
// query cache, the live store text is shown. Once the persisted assistant
// message arrives, the persisted copy is rendered instead — no flash of empty
// content during the persist-then-invalidate window.
//
// Per-part rendering (REQ-14.1, 14.5): assistant messages carry `text` /
// `tool_call` / `tool_result` parts. We walk them IN ORDER — `text` →
// MarkdownRenderer (sanitised, lazy shiki highlighting); `tool_call` → a
// collapsed "Called {tool}" affordance; `tool_result` → a typed card matched to
// its originating tool_call by toolCallId. A tool-only assistant turn therefore
// renders its cards on reload (not an empty bubble), and streaming + reload use
// the same components. User text is plain text — no Markdown.

import { useShallow } from 'zustand/shallow';

import type {
  Message,
  ResponseMessageContentPart,
  ToolResultPart,
} from '@tradr/shared/schemas/advisor';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { isApiCrossOrigin, resolveApiUrl } from '@/lib/api';

import { useConversation } from '../hooks/useConversations';
import { useStreamStore, type StreamState, type ToolActivity } from '../stores/stream.store';

import { MarkdownRenderer } from './MarkdownRenderer';
import { GenericToolCard, safeStringify } from './tool-cards/GenericToolCard';
import { MarketDataCard } from './tool-cards/MarketDataCard';
import { TradeDataCard } from './tool-cards/TradeDataCard';

export interface TranscriptProps {
  conversationId: string;
  // Re-submits the original user message with the original clientMessageId
  // (REQ-1.7). The parent (Composer/AdvisorPage) owns the actual submission.
  onRetry: () => void;
}

const IDLE: StreamState = { kind: 'idle' };

// Chat bubbles: you on the left, the advisor on the right. Three nested
// elements, each with one job —
//   ROW    justifies to a side. It is the STACK that moves, never the text
//          inside the bubble, which stays left-read on both sides.
//   STACK  holds the nametag over the bubble and caps the pair's width. It
//          shrinks to its content, so a short message gets a short bubble.
//   BUBBLE carries the fill, so the speakers are told apart twice over — by
//          position and by colour.
//
// `min-w-0` on both STACK and BUBBLE is load-bearing: a flex item's default
// `min-width: auto` refuses to shrink below its content, so a wide table or a
// long code line would push the whole transcript sideways instead of scrolling
// inside its own `overflow-x-auto` container.
const ROW_USER = 'flex justify-start';
const ROW_ASSISTANT = 'flex justify-end';
const STACK = 'flex min-w-0 max-w-[85%] flex-col gap-1';
const BUBBLE = 'min-w-0 rounded-xl px-4 py-3 break-words';
// The desk bubbles (visual-redesign task 8): the user speaks on a neutral
// secondary surface — amber never encodes data, and painting every question
// in the accent spent it wholesale. Each bubble tightens the corner nearest
// its speaker (the mock's 10/10/10/3 grammar).
const BUBBLE_USER = 'rounded-bl-sm bg-secondary text-foreground';
// Deliberately a bordered card, NOT a grey fill: `muted` and `secondary` hold
// the same value in both themes, and MarkdownRenderer's inline code and code
// fallback are `bg-muted` — on a muted bubble they would vanish into it.
// Hairline, per the desk surface grammar.
const BUBBLE_ASSISTANT = 'rounded-br-sm border border-hairline bg-card';
// Quiet enough to read as an attribution rather than content. Aligned to the
// bubble's own edge, so it sits over the side its speaker occupies.
const LABEL = 'px-1 text-xs text-muted-foreground';

function userText(message: Message): string {
  return message.contentParts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// Picks the typed card for a tool_result by its originating tool name. Unknown
// names (or none) fall back to GenericToolCard, which never crashes (REQ-14.2).
function ToolResultCard({ toolName, result }: { toolName?: string; result: ToolResultPart }) {
  if (toolName?.startsWith('market_data_')) {
    return <MarketDataCard toolName={toolName} result={result} />;
  }
  if (toolName?.startsWith('trade_data_')) {
    return <TradeDataCard toolName={toolName} result={result} />;
  }
  return <GenericToolCard toolName={toolName} result={result} />;
}

// Collapsed "Called {tool}" affordance for a persisted tool_call part (REQ-14.1).
function CalledToolAffordance({ name, args }: { name: string; args: unknown }) {
  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="cursor-pointer text-muted-foreground"
        >
          Called {name}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {safeStringify(args)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

type ImageContentPart = Extract<ResponseMessageContentPart, { type: 'image' }>;

const IMAGE_CLASS = 'my-1 max-h-80 max-w-full rounded-md border border-border';

// Renders one image content-part in whichever of its three states it is in
// (hosted-platform REQ-2.3):
//   • inline (or legacy unmarked)  → a data: URL from the base64 payload;
//   • pointer  {storage:'object'}  → the ownership-scoped image proxy, keyed by
//     conversationId/messageId/index (the object key never appears in the URL);
//   • unrecoverable                → a defined, non-crashing placeholder — never
//     a broken <img> or an exception.
// `crossOrigin="use-credentials"` is set ONLY when the API origin differs from
// the page origin (split-origin); same-origin never sets it.
function AdvisorImagePart({
  part,
  conversationId,
  messageId,
  index,
}: {
  part: ImageContentPart;
  conversationId: string;
  messageId: string;
  index: number;
}) {
  if ('dataBase64' in part) {
    return (
      <img
        src={`data:image/${part.format};base64,${part.dataBase64}`}
        alt=""
        className={IMAGE_CLASS}
      />
    );
  }

  if (part.storage === 'unrecoverable') {
    return (
      <div
        role="img"
        aria-label="Image no longer available"
        data-testid="image-unavailable"
        className="my-1 flex h-32 w-48 items-center justify-center rounded-md border border-dashed border-border bg-muted text-xs text-muted-foreground"
      >
        Image no longer available
      </div>
    );
  }

  const src = resolveApiUrl(
    `/advisor/conversations/${conversationId}/messages/${messageId}/images/${index}`,
  );
  return (
    <img
      src={src}
      alt=""
      className={IMAGE_CLASS}
      {...(isApiCrossOrigin() ? { crossOrigin: 'use-credentials' as const } : {})}
    />
  );
}

// Renders the image parts of a message (used for user uploads, which carry the
// attachments). The `index` is the part's position in the full `contentParts`
// array — the same index the image proxy resolves server-side.
function renderImageParts(message: Message, conversationId: string) {
  return message.contentParts.map((part, i) =>
    part.type === 'image' ? (
      <AdvisorImagePart
        key={i}
        part={part}
        conversationId={conversationId}
        messageId={message.id}
        index={i}
      />
    ) : null,
  );
}

/** The answer's compact provenance row (visual-redesign task 8): one chip per
 * distinct tool the message called, derived from the tool_call parts already
 * in the transcript. The inline tool cards above show the work verbatim; this
 * is the desk summary at the end of the answer. */
function CitesRow({ message }: { message: Message }) {
  const names = [
    ...new Set(
      message.contentParts
        .filter((p): p is { type: 'tool_call'; id: string; name: string } => p.type === 'tool_call')
        .map((p) => p.name.replaceAll('_', ' ')),
    ),
  ];
  if (names.length === 0) return null;
  return (
    <div
      data-testid="cites-row"
      className="mt-2 flex flex-wrap gap-1.5 font-mono text-xs text-muted-foreground"
    >
      <span className="py-0.5">used:</span>
      {names.map((name) => (
        <span key={name} className="rounded-full border border-hairline px-2 py-0.5">
          {name}
        </span>
      ))}
    </div>
  );
}

// Walks an assistant message's parts in order, rendering each by type. tool_call
// names are indexed by id so tool_result cards can resolve their typed card.
function renderAssistantParts(message: Message, conversationId: string) {
  const parts = message.contentParts;
  const callNamesById = new Map<string, string>();
  for (const part of parts) {
    if (part.type === 'tool_call') callNamesById.set(part.id, part.name);
  }

  return parts.map((part, i) => {
    if (part.type === 'text') {
      return <MarkdownRenderer key={i} content={part.text} />;
    }
    if (part.type === 'tool_call') {
      return <CalledToolAffordance key={i} name={part.name} args={part.arguments} />;
    }
    if (part.type === 'tool_result') {
      return <ToolResultCard key={i} toolName={callNamesById.get(part.toolCallId)} result={part} />;
    }
    if (part.type === 'image') {
      return (
        <AdvisorImagePart
          key={i}
          part={part}
          conversationId={conversationId}
          messageId={message.id}
          index={i}
        />
      );
    }
    return null;
  });
}

// Inline "Calling {tool}…" affordance driven by streamed tool activity (REQ-14.1).
function StreamingToolAffordance({ tool }: { tool: ToolActivity }) {
  const label =
    tool.status === 'pending'
      ? `Calling ${tool.name}…`
      : tool.status === 'error'
        ? `${tool.name} couldn't complete`
        : `Called ${tool.name}`;
  return (
    <div data-testid="streaming-tool" className="my-1 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

export function Transcript({ conversationId, onRetry }: TranscriptProps) {
  const { data } = useConversation(conversationId);
  const messages = data?.messages ?? [];

  // Narrow slice subscription. useShallow re-renders only when this object's
  // fields change, not on cross-conversation store mutations (design v3-9).
  const stream = useStreamStore(useShallow((s) => s.byConversation[conversationId] ?? IDLE));
  const tools = useStreamStore(
    useShallow((s) => s.toolsByConversation[conversationId] ?? EMPTY_TOOLS),
  );
  const billingMode = useStreamStore(
    useShallow((s) => s.billingModeByConversation?.[conversationId]),
  );

  // Handoff: suppress the live store entry once the persisted assistant message
  // it represents is in the cache (matched by the done-recorded messageId).
  const persistedIds = new Set(messages.map((m) => m.id));
  const showStreamEntry =
    stream.kind === 'streaming' ||
    stream.kind === 'error' ||
    (stream.kind === 'done' && !persistedIds.has(stream.messageId));

  return (
    <div data-testid="transcript" className="flex flex-col gap-4 p-4">
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className={ROW_USER}>
            <div className={STACK}>
              <span className={`${LABEL} text-left`}>Me</span>
              <div data-role="user" className={`${BUBBLE} ${BUBBLE_USER} whitespace-pre-wrap`}>
                {userText(message)}
                {renderImageParts(message, conversationId)}
              </div>
            </div>
          </div>
        ) : (
          <div key={message.id} className={ROW_ASSISTANT}>
            <div className={STACK}>
              <span className={`${LABEL} text-right`}>Advisor</span>
              <div data-role="assistant" className={`${BUBBLE} ${BUBBLE_ASSISTANT}`}>
                {renderAssistantParts(message, conversationId)}
                <CitesRow message={message} />
              </div>
            </div>
          </div>
        ),
      )}

      {showStreamEntry && (
        <div className={ROW_ASSISTANT}>
          <div className={STACK}>
            <span className={`${LABEL} text-right`}>Advisor</span>
            <div
              data-role="assistant"
              data-testid="stream-entry"
              className={`${BUBBLE} ${BUBBLE_ASSISTANT}`}
            >
              {billingMode && (
                <div data-testid="billing-mode" className="mb-1 text-xs text-muted-foreground">
                  {billingMode.mode === 'platform'
                    ? billingMode.fellThrough
                      ? 'Billed with platform credits (no key for this provider).'
                      : 'Billed with platform credits.'
                    : 'Using your own provider key (no credits charged).'}
                </div>
              )}

              {tools.map((t) => (
                <StreamingToolAffordance key={t.id} tool={t} />
              ))}

              {stream.text.length > 0 && <MarkdownRenderer content={stream.text} />}

              {stream.kind === 'error' && (
                <div data-testid="stream-error" className="mt-2 flex items-center gap-3">
                  <span className="text-sm text-destructive">Response interrupted — retry?</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY_TOOLS: ToolActivity[] = [];
