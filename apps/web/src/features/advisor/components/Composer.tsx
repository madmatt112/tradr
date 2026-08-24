// Composer — multi-line message input with image attachments and a persona
// selector (REQ-1.12, REQ-1.14, REQ-1.15, REQ-1.16).
//
// The Composer owns the draft (text + attachments + selected persona) and
// generates a fresh `clientMessageId` (UUID v4) per submission. It does NOT own
// the streaming mutation — the parent (AdvisorPage, Task 43) passes `onSubmit`
// wired to `useAdvisorStream` (Task 31). The Composer calls `onSubmit` exactly
// once per Enter / Send click; the parent's mutation is `retry: 0` (REQ-1.16),
// so no double-firing of the billable stream.
//
// Vision gating (REQ-1.14): the paperclip and clipboard-paste image paths are
// active only when `visionEnabled` is true (parent resolves this from the
// selected provider/model). For non-vision models the paperclip is hidden and
// pasted images are ignored.
//
// Hard-cap preservation (REQ-1.15): when the parent reports
// `errorCode === 'CONVERSATION_TOO_LONG'`, the composer keeps the typed text and
// attachments and renders an inline block message with a "New conversation"
// button that opens a new conversation with the same draft pre-filled.

import { Link } from '@tanstack/react-router';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { TierState } from '@tradr/shared';
import { MAX_IMAGE_BYTES_DEFAULT } from '@tradr/shared/schemas/advisor';
import type { Persona, ProviderId } from '@tradr/shared/schemas/advisor';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { captureClientEvent } from '@/lib/telemetry/posthog';

import { approachingRemaining, hasAllowanceHeadroom } from '../../billing/tier-usage';

// Client-side caps mirror the server-authoritative limits (REQ-8.1 / shared
// StreamRequestSchema: attachments.max(4)). The composer never exceeds them.
const MAX_ATTACHMENTS = 4;

type ImageFormat = 'png' | 'jpeg' | 'webp';

const ACCEPTED_IMAGE_FORMATS: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

export interface ComposerDraft {
  text: string;
  attachments: ImageAttachment[];
}

/** An image part plus the object URL used for the local thumbnail preview. */
export interface ImageAttachment {
  format: ImageFormat;
  dataBase64: string;
  previewUrl: string;
}

export interface ComposerSubmit {
  clientMessageId: string;
  text: string;
  attachments: { type: 'image'; format: ImageFormat; dataBase64: string }[];
  personaId?: string;
  /**
   * Provider/model the platform should bill this turn against (wallet-billing
   * REQ-4.3). Sent ONLY on a no-BYOK new platform conversation; undefined for
   * BYOK users and for existing conversations (which keep their pinned model).
   */
  providerOverride?: { providerId: ProviderId; model: string };
}

export interface ComposerProps {
  /** Personas to offer in the selector (built-ins + user-owned). */
  personas: Persona[];
  /** Persona pre-selected when the composer mounts. */
  defaultPersonaId?: string;
  /** True only when the selected provider/model supports image input. */
  visionEnabled: boolean;
  /** Disabled while a stream is in flight (REQ-1.6e) or no key is configured. */
  disabled?: boolean;
  /** True while the submitted turn is in flight — the send button shows a spinner. */
  pending?: boolean;
  /**
   * Error code from the most recent submission, surfaced by the parent.
   * `CONVERSATION_TOO_LONG` changes the composer's own rendering (REQ-1.15); the
   * pre-stream billing refusals (`INSUFFICIENT_CREDITS`, `BILLING_NOT_AVAILABLE`,
   * `MODEL_REQUIRED`, `MODEL_NOT_AVAILABLE`, `ALLOWANCE_EXHAUSTED`,
   * `INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE`, `TIER_LIMIT_IMAGES`) render an
   * inline refusal banner (wallet-billing REQ-6.4/7.6; plan-tiers REQ-8.2/8.9c/
   * 9.2/11.5). Branching is on the CODE only, never on message text.
   */
  errorCode?: string;
  /**
   * Tier state from GET /api/billing/tier (plan-tiers Component 12), already
   * fetched by the parent — the Composer never fetches. Drives the ≥80%
   * remaining hints (REQ-11.6) and the free-turns headroom disclosures
   * (REQ-8.9c). Absent (self-host, loading) ⇒ no hints, no disclosures.
   */
  tierState?: TierState;
  /**
   * Which paid remedies are actually available (REQ-8.2): `buyCredits` when
   * platform billing is enabled (config `enabled`), `upgrade` when the Pro
   * subscription is purchasable (config `subscription.purchasable`). A remedy
   * never renders without its flag — no dead-end links.
   */
  remedies?: { buyCredits: boolean; upgrade: boolean };
  /**
   * The config-marked allowance model (gating-gated, D16). Names the model in
   * the free-turns disclosures; absent on self-host ⇒ no disclosure.
   */
  allowanceModel?: string;
  /**
   * True on an existing conversation — its provider/model is pinned (no re-pin
   * affordance exists), so the REQ-8.9c disclosure points at starting a new
   * conversation instead of switching models in the picker.
   */
  pinnedConversation?: boolean;
  /**
   * The platform provider/model to bill against, for a no-BYOK new platform
   * conversation (wallet-billing REQ-4.3). When set, it is attached to each
   * submission as `providerOverride`. Undefined for BYOK users and existing
   * conversations — those send no override.
   */
  providerOverride?: { providerId: ProviderId; model: string };
  /** Fired exactly once per Enter / Send click. */
  onSubmit: (submission: ComposerSubmit) => void;
  /** Fired by the "New conversation" button on the hard-cap path (REQ-1.15). */
  onStartNewConversation?: (draft: ComposerDraft) => void;
}

// The per-image encoded-byte cap for the client-side pre-upload check. The
// runtime-config seam always emits `advisorImageMaxBytes` (defaulting to
// MAX_IMAGE_BYTES_DEFAULT when the operator sets no override), so this reader
// always has a cap; the fallback covers dev/test where /config.js is absent
// (hosted-platform REQ-4.6). The server schema stays authoritative.
function advisorImageMaxBytes(): number {
  const configured =
    typeof window !== 'undefined' ? window.__TRADR_CONFIG__?.advisorImageMaxBytes : undefined;
  return typeof configured === 'number' && configured > 0 ? configured : MAX_IMAGE_BYTES_DEFAULT;
}

// A refusal-banner action: a link into the billing tab (optionally the upgrade
// CTA, which fires the D17 funnel event) or the new-conversation escape hatch.
type RefusalAction =
  | { kind: 'billing-link'; label: string; isUpgradeCta?: boolean }
  | { kind: 'new-conversation'; label: string };

interface BillingRefusalView {
  message: string;
  actions: RefusalAction[];
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the `data:<mime>;base64,` prefix — only the payload is persisted.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  personas,
  defaultPersonaId,
  visionEnabled,
  disabled = false,
  pending = false,
  errorCode,
  tierState,
  remedies,
  allowanceModel,
  pinnedConversation = false,
  providerOverride,
  onSubmit,
  onStartNewConversation,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [personaId, setPersonaId] = useState<string | undefined>(defaultPersonaId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hardCapped = errorCode === 'CONVERSATION_TOO_LONG';

  // Remedy availability (REQ-8.2): each paid remedy renders ONLY when it is
  // actually available — never a dead-end link.
  const buyCreditsAction: RefusalAction | null = remedies?.buyCredits
    ? { kind: 'billing-link', label: 'Buy credits' }
    : null;
  const upgradeAction: RefusalAction | null = remedies?.upgrade
    ? { kind: 'billing-link', label: 'Upgrade to Pro', isUpgradeCta: true }
    : null;
  const paidRemedies: RefusalAction[] = [buyCreditsAction, upgradeAction].filter((a) => a !== null);

  // Free platform-turn headroom (REQ-8.9c) from the parent's already-fetched
  // tier state; false while loading / on self-host, so disclosures stay off.
  const allowanceHeadroom = hasAllowanceHeadroom(tierState);

  // Pre-stream billing refusals (wallet-billing REQ-6.4/7.6; plan-tiers
  // REQ-8.2/8.9c/9.2/11.5). These are 402/403 JSON envelopes that never open an
  // SSE stream, so they arrive here as `errorCode` (via
  // AdvisorPage.stream.error.code) rather than through the transcript. The
  // former TIER_LIMIT_EXCEEDED branch is retired with its server code (plan-tiers
  // Task 13): tier limits are now purchasable-away, so unknown codes — including
  // the retired one — render nothing.
  const billingRefusal: BillingRefusalView | null = (() => {
    switch (errorCode) {
      case 'INSUFFICIENT_CREDITS':
        return {
          message: "You're out of credits.",
          actions: [{ kind: 'billing-link' as const, label: 'Add credits' }],
        };
      case 'BILLING_NOT_AVAILABLE':
        // The code keeps its exact meaning (honest posture, no purchase links).
        // REQ-8.9c's disclosure is client-side on a gated Stripe-less instance:
        // annotate the message with the free monthly turns whenever tier state
        // shows headroom and the config names an allowance model.
        return {
          message:
            allowanceModel && allowanceHeadroom
              ? `Platform billing is not enabled on this instance. Free monthly turns are available on ${allowanceModel} — start a new conversation.`
              : 'Platform billing is not enabled on this instance.',
          actions: [],
        };
      case 'MODEL_REQUIRED':
        return { message: 'Select a provider and model to start.', actions: [] };
      case 'MODEL_NOT_AVAILABLE':
        return {
          message:
            "This model isn't available on credits — pick another model or start a new conversation.",
          actions: [],
        };
      case 'ALLOWANCE_EXHAUSTED':
        // REQ-8.2: free monthly turns used up AND credits insufficient — offer
        // each available paid remedy.
        return {
          message:
            "You've used your free monthly turns — they reset at the start of next month (UTC).",
          actions: paidRemedies,
        };
      case 'INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE': {
        // REQ-8.9c: out of credits on a premium model while free turns remain on
        // the allowance model. An existing conversation is pinned to its model,
        // so the disclosure points at starting a new conversation.
        const modelName = allowanceModel ?? 'the free-turns model';
        return {
          message: pinnedConversation
            ? `You're out of credits, but free monthly turns are available on ${modelName} — start a new conversation to use them.`
            : `You're out of credits, but free monthly turns are available on ${modelName} — select it to use them.`,
          actions: [
            ...paidRemedies,
            ...(pinnedConversation
              ? [{ kind: 'new-conversation' as const, label: 'New conversation' }]
              : []),
          ],
        };
      }
      case 'TIER_LIMIT_IMAGES':
        // REQ-9.2: monthly image quota hit — pre-stream 403; text-only turns are
        // unaffected (this banner never blocks submission, unlike the hard cap).
        return {
          message:
            'Monthly image upload limit reached — resets at the start of next month (UTC). Text-only messages still work.',
          actions: upgradeAction ? [upgradeAction] : [],
        };
      default:
        return null;
    }
  })();

  // ≥80% approaching-limit hints (REQ-11.6 working default) from the parent's
  // already-fetched tier state — disclosure BEFORE refusal, no new API surface.
  const currentCaps = tierState?.usage ? tierState.limits[tierState.tier] : undefined;
  const turnsHint = approachingRemaining(
    tierState?.usage?.platformTurns.allowanceUsed,
    currentCaps?.platformTurns,
  );
  const imagesHint = approachingRemaining(tierState?.usage?.images.used, currentCaps?.images);

  const addFiles = async (files: File[]) => {
    if (!visionEnabled) return;
    const cap = advisorImageMaxBytes();
    let dropped = false;
    let oversized = false;
    for (const file of files) {
      const format = ACCEPTED_IMAGE_FORMATS[file.type];
      if (!format) continue;
      // Read base64, then append only if room remains (REQ-1.14: max 4).
      const dataBase64 = await fileToBase64(file);
      // Client-side pre-upload cap (hosted-platform REQ-4.6): reject before the
      // image ever leaves the browser. The cap is on the ENCODED length, matching
      // the server's authoritative dataBase64 .max() check.
      if (dataBase64.length > cap) {
        oversized = true;
        continue;
      }
      setAttachments((prev) => {
        if (prev.length >= MAX_ATTACHMENTS) {
          dropped = true;
          return prev;
        }
        return [...prev, { format, dataBase64, previewUrl: URL.createObjectURL(file) }];
      });
    }
    if (dropped) {
      toast.error(`You can attach at most ${MAX_ATTACHMENTS} images.`);
    }
    if (oversized) {
      toast.error('That image is too large to upload.');
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!visionEnabled) return;
    const imageFiles = Array.from(event.clipboardData.files).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addFiles(imageFiles);
    }
  };

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    void addFiles(files);
    // reset so re-picking the same file fires change again.
    event.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const next = prev.slice();
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  // Self-contained guard: block submission while in the hard-cap state even if
  // the parent forgets to pass disabled=true (REQ-1.15).
  const canSend = !disabled && !hardCapped && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSubmit({
      clientMessageId: crypto.randomUUID(),
      text: text.trim(),
      attachments: attachments.map((a) => ({
        type: 'image' as const,
        format: a.format,
        dataBase64: a.dataBase64,
      })),
      personaId,
      ...(providerOverride ? { providerOverride } : {}),
    });
    // Clear the draft on a normal send (the hard-cap path never reaches here —
    // it short-circuits in the parent before re-enabling submit).
    setText('');
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (REQ-1.12). Never auto-submit
    // on Shift+Enter.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div data-testid="composer" className="flex flex-col gap-2 border-t p-3">
      {hardCapped && (
        <div
          data-testid="hard-cap-block"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
        >
          <span className="text-sm text-destructive">
            This conversation is too long. Start a new conversation to continue.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() =>
              onStartNewConversation?.({
                text,
                attachments,
              })
            }
          >
            New conversation
          </Button>
        </div>
      )}

      {billingRefusal && (
        <div
          data-testid="billing-refusal"
          data-error-code={errorCode}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
        >
          <span className="text-sm text-destructive">{billingRefusal.message}</span>
          {billingRefusal.actions.length > 0 && (
            <div className="flex items-center gap-2">
              {billingRefusal.actions.map((action) =>
                action.kind === 'billing-link' ? (
                  <Button
                    key={action.label}
                    asChild
                    size="sm"
                    variant="outline"
                    className="cursor-pointer"
                  >
                    <Link
                      to="/settings/billing"
                      onClick={
                        action.isUpgradeCta
                          ? () =>
                              // D17/REQ-13.1 funnel event — upgrade CTAs on
                              // refusal surfaces carry their surface identity.
                              captureClientEvent('upgrade_cta_clicked', { surface: 'composer' })
                          : undefined
                      }
                    >
                      {action.label}
                    </Link>
                  </Button>
                ) : (
                  <Button
                    key={action.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => onStartNewConversation?.({ text, attachments })}
                  >
                    {action.label}
                  </Button>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {(turnsHint !== null || imagesHint !== null) && (
        <div
          data-testid="tier-usage-hints"
          className="flex flex-wrap gap-3 text-xs text-muted-foreground"
        >
          {turnsHint !== null && <span>{turnsHint} free turns left this month</span>}
          {imagesHint !== null && <span>{imagesHint} image uploads left</span>}
        </div>
      )}

      {attachments.length > 0 && (
        <ul data-testid="attachment-previews" className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <li key={attachment.previewUrl} className="relative">
              <img
                src={attachment.previewUrl}
                alt="Attachment preview"
                className="size-16 rounded-md object-cover"
              />
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Remove attachment"
                className="absolute -right-2 -top-2 size-5 cursor-pointer rounded-full"
                onClick={() => removeAttachment(index)}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Textarea
        aria-label="Message"
        placeholder="Message the Tradr Advisor…"
        value={text}
        disabled={disabled || hardCapped}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />

      <div className="flex items-center gap-2">
        <select
          aria-label="Persona"
          value={personaId ?? ''}
          disabled={disabled}
          onChange={(e) => setPersonaId(e.target.value || undefined)}
          className="h-9 cursor-pointer rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>

        {visionEnabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              data-testid="file-input"
              onChange={onPickFiles}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Attach image"
              disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
              className="cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
          </>
        )}

        <Button
          type="button"
          aria-label="Send message"
          aria-busy={pending || undefined}
          disabled={!canSend}
          className="ml-auto cursor-pointer"
          onClick={submit}
        >
          {pending ? (
            <Loader2
              data-testid="send-spinner"
              className="size-4 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Send className="size-4" />
          )}
          Send
        </Button>
      </div>
    </div>
  );
}
