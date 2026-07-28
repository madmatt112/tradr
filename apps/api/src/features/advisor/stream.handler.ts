// Streaming endpoint handler (design §Component 7; REQ-1.6–1.8, REQ-3.x, 8.1).
//
// This handler owns the pre-stream steps the route is responsible for BEFORE
// calling prepare() (design §Component 3 step table):
//   1. Validate the request body (Zod) incl. the operator-tunable per-image
//      byte cap — rejected at validation time, before any decode (REQ-4.2/4.6).
//   2. Assert conversation ownership → NOT_FOUND (assertOwnsConversation).
//   3. Load history + persona + provider key + model (loadStreamContext).
//   4. Decrypt the BYOK key (encryption.ts) → KEY_DECRYPT_FAILED on failure.
// It then resolves the selected ProviderModel (needs the plaintext key),
// enforces the vision capability and the tier checks (plan-tiers D10: the L5
// image quota for all credential sources, the L4 allowance/credits split on
// the platform path), hands a fully-loaded StreamContext to prepare(), and
// opens the SSE response.
//
// Pre-stream errors are THROWN as AppError subclasses (design v4) — Hono's
// onError middleware serialises them to JSON envelopes with the right status
// BEFORE any SSE header is written. prepare() either throws (pre-stream) or
// returns a valid Prepared, so the handler NEVER calls iter.next() before
// opening SSE.
//
// Slot lifecycle (design v4-1): releaseSlot() is called in a route-level
// try/finally after prepare() returns — runStreaming never releases the slot.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { makeStreamRequestSchema, MAX_IMAGE_BYTES_DEFAULT } from '@tradr/shared';
import type { CanonicalPart, ProviderModel, StreamRequestInput } from '@tradr/shared';

import { db } from '@/db';
import { config, getPlatformApiKey } from '@/lib/config';
import { decrypt, EncryptionError } from '@/lib/encryption';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { stripImageMetadata } from '@/lib/image-metadata';
import { captureServerEvent } from '@/lib/posthog';

import { getAllowanceUsage, getImageCount } from '../admin/gating.query';
import { gateAndReserve, releaseReservation } from '../billing/billing.service';
import { isModelPriced, PLATFORM_DEFAULT_MODEL } from '../billing/pricing';
import { ALLOWANCE_MODEL, PERIOD_KEY } from '../billing/tier-limits.constants';
import { getTierContext } from '../billing/tier.query';

import {
  ImageTooLargeError,
  KeyDecryptFailedError,
  ModelDoesNotSupportVisionError,
  ModelNotListedError,
} from './advisor.errors';
import { assertOwnsConversation, loadStreamContext } from './advisor.query';
import { getProvider } from './providers/registry';
import { prepare, resolveForProvider, runStreaming } from './streaming';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

// REQ-3.7 / design §Component 3 §6: SSE comment keepalive. With the app-level
// inactivity timer cleared during tool execution and the summary call, no SSE
// byte flows for up to PER_TOOL_TIMEOUT_MS per tool — enough to trip an
// intermediary idle timeout. A route-side interval (NOT a generator yield —
// the generator is blocked on a tool await during the silent window) writes a
// `:`-comment frame every HEARTBEAT_MS of silence, reset on every real frame
// and cleared in finally. The comment carries no `data:` line (so it cannot be
// a `writeSSE` call, which always emits a `data:` line) and the frontend SSE
// client already ignores `:`-comment lines (sse.ts).
export const HEARTBEAT_MS = 10_000;
const HEARTBEAT_FRAME = ': keepalive\n\n';

/**
 * Unconditional EXIF/metadata strip at the single ingestion seam (REQ-2.5/8.2,
 * design §Component 9). Runs `stripImageMetadata` over every uploaded image's
 * bytes, mutating `body.attachments[].dataBase64` in place so the STRIPPED bytes
 * are the ones `buildNewMessageParts` (streaming.ts) stores via persistTurn AND
 * forwards to the provider. This is the single, intentional normalization point
 * for the validated `body`: the per-image byte cap already ran at schema
 * validation (before any decode, REQ-4.2), so this runs immediately after and
 * before `prepare`, so no later reader needs the unstripped bytes. Unconditional
 * — applies to BYOK too; stripping changes neither pixels nor `format`, so
 * existing vision tests pass.
 */
function stripImageAttachments(input: StreamRequestInput): void {
  for (const att of input.attachments ?? []) {
    if (att.type !== 'image') continue;
    const stripped = stripImageMetadata(att.format, Buffer.from(att.dataBase64, 'base64'));
    att.dataBase64 = stripped.toString('base64');
  }
}

function imageCountOf(parts: readonly CanonicalPart[]): number {
  return parts.filter((p) => p.type === 'image').length;
}

/**
 * The streaming endpoint handler. Mounted by advisor.route.ts behind
 * authMiddleware + a per-user rate limiter on both the existing-conversation
 * (`/conversations/:id/messages/stream`) and new-conversation
 * (`/conversations/new/messages/stream`) variants.
 */
export async function streamHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationParam = c.req.param('id'); // 'new' or a UUID
  const conversationId = conversationParam === 'new' ? null : (conversationParam ?? null);
  const abortSignal = c.req.raw.signal;

  // Step 1 — validate the request body against the operator-tunable per-image
  // byte cap (REQ-4.6). The per-image `.max()` on `dataBase64` rejects an
  // oversized image at validation time, BEFORE any base64 decode (REQ-4.2, no
  // OOM). A cap hit carries the schema's `IMAGE_TOO_LARGE` message and surfaces
  // as IMAGE_TOO_LARGE; any other Zod failure (incl. > 4 images and the
  // clientMessageId UUID rule) becomes a VALIDATION_ERROR JSON envelope.
  const schema = makeStreamRequestSchema(config.ADVISOR_IMAGE_MAX_BYTES ?? MAX_IMAGE_BYTES_DEFAULT);
  const parsed = schema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    let imageTooLarge = false;
    for (const issue of parsed.error.issues) {
      if (issue.message === 'IMAGE_TOO_LARGE') imageTooLarge = true;
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    if (imageTooLarge) {
      throw new ImageTooLargeError('An image exceeds the configured per-image byte cap');
    }
    throw new ValidationError('Validation failed', details);
  }
  const body: StreamRequestInput = parsed.data;

  // Step 1b — unconditional EXIF/metadata strip (REQ-2.5/8.2, §Component 9). The
  // per-image size cap already ran at schema validation (before decode), so this
  // is the single normalization point: after validation, before prepare(), so
  // the stripped bytes are what gets stored AND forwarded to the provider key.
  stripImageAttachments(body);

  // Step 2 — ownership check (existing-conversation flows only).
  if (conversationId !== null) {
    await assertOwnsConversation(conversationId, userId);
  }

  // Step 3 — load history + persona + provider/model + (optional) BYOK key.
  // §Component 5: `providerOverride` is honoured ONLY on the new-conversation
  // path; an existing conversation's provider/model come solely from the
  // conversation row, so a client override is ignored here.
  const ctx = await loadStreamContext({
    conversationId,
    userId,
    personaId: body.personaId,
    providerOverride: conversationId === null ? body.providerOverride : undefined,
  });

  // Resolve the turn's provider/model + credential source (§Component 5,
  // REQ-4). `ctx.providerId`/`ctx.modelId` are already defined by
  // loadStreamContext; here we apply the platform-admission validation and the
  // existing-conversation unpriced-model fallback, then choose the credential.
  const { providerId } = ctx;
  let { modelId } = ctx;
  const byok = ctx.encryptedKey !== null;
  const platformKey = getPlatformApiKey(providerId);

  if (!byok) {
    // No BYOK key for the resolved provider. When no platform key is
    // configured either, preserve advisor-core's "configure a key" outcome
    // (REQ-4.2 path 3 / REQ-10.3) — NOT a 500 / wrong code.
    if (!platformKey) {
      throw new NotFoundError('ProviderKey', providerId);
    }
    // Platform path. Validate model admission per turn type:
    if (conversationId === null) {
      // New platform conversation: the model came from `providerOverride`
      // (loadStreamContext throws MODEL_REQUIRED when neither a key nor an
      // override is present). It must be priced to be admissible on credits.
      if (!isModelPriced(providerId, modelId)) {
        throw new AppError(400, 'MODEL_REQUIRED', 'select a provider and model to start');
      }
    } else if (!isModelPriced(providerId, modelId)) {
      // Existing platform conversation whose pinned model is now unpriced:
      // fall back to the provider's default priced model for this turn
      // (REQ-4.4 option a) — never rewrite conv.model, never brick the
      // conversation. The user-facing disclosure notice is Task 13.
      const fallbackModel = PLATFORM_DEFAULT_MODEL[providerId];
      if (fallbackModel === undefined) {
        // BYOK-only provider (empty priced set): a platform conversation can
        // never exist for it — defensive, mirrors the new-conversation gate.
        throw new AppError(400, 'MODEL_REQUIRED', 'select a provider and model to start');
      }
      modelId = fallbackModel;
    }
    // Platform key configured + admissible model: this is the platform path.
    // The L4 allowance/credits split + pre-flight credit gate run below,
    // before prepare() (plan-tiers D10); a failing gate refuses 402.
  }

  // Step 4 — resolve the credential. BYOK → decrypt (a decrypt failure is a
  // server configuration problem → KEY_DECRYPT_FAILED, 500). Platform → the
  // env key (never DB, never logged); NEVER decrypt(null).
  let apiKey: string;
  if (byok) {
    try {
      apiKey = decrypt(ctx.encryptedKey as string);
    } catch (err) {
      if (err instanceof EncryptionError) {
        throw new KeyDecryptFailedError();
      }
      throw err;
    }
  } else {
    // Non-null guaranteed by the refuse cascade above (NotFoundError thrown
    // when no platform key is configured).
    apiKey = platformKey as string;
  }

  // Resolve the selected ProviderModel (needs the resolved key) for the vision
  // capability check + the hard-cap context window. Uses the resolved
  // provider/model (override on a new platform conv, conv on an existing one).
  const adapter = getProvider(providerId);
  const models = await adapter.listModels(apiKey);
  const providerModel: ProviderModel | undefined = models.find((m) => m.id === modelId);
  if (!providerModel) {
    throw new ModelNotListedError();
  }

  // Vision capability check (REQ-8.4) — surfaced BEFORE the upstream call.
  const newImageCount = imageCountOf([
    { type: 'text', text: body.text },
    ...(body.attachments ?? []),
  ]);
  if (newImageCount > 0 && !providerModel.vision) {
    throw new ModelDoesNotSupportVisionError();
  }

  // Tier context (plan-tiers D10) — loaded ONCE per turn, for ALL credential
  // sources, beside the vision check: the L5 image quota below is
  // tier-dependent and applies to BYOK turns too (REQ-9.1), and the L4
  // allowance/credits split (platform path only) consumes it further down.
  // Gating off / admin ⇒ `{ enforced: false }` with no DB read.
  const tierCtx = await getTierContext(db, { userId, isAdmin: c.get('isAdmin') });

  // L5 image quota (REQ-9.1/9.2) — pre-stream, all credential sources (BYOK
  // included: a storage/abuse lever, not a billing lever). When the committed
  // monthly count plus this turn's attachments would exceed the tier quota,
  // refuse 403 TIER_LIMIT_IMAGES (terminal for state — never 429, no
  // Retry-After; D12). Text-only turns never touch it. The committed-count
  // read carries the REQ-9.1 concurrency-overshoot posture.
  if (newImageCount > 0 && tierCtx.enforced && tierCtx.limits.images !== null) {
    const committedImages = await getImageCount(db, userId, PERIOD_KEY());
    if (committedImages + newImageCount > tierCtx.limits.images) {
      captureServerEvent('tier_limit_hit', {
        distinctId: userId,
        properties: { lever: 'images' },
      });
      throw new AppError(
        403,
        'TIER_LIMIT_IMAGES',
        `Monthly image limit reached (${tierCtx.limits.images} images/month on your plan). The limit resets at the start of next month (UTC).`,
      );
    }
  }

  // Pre-flight credit gate + atomic reservation (wallet-billing Component 6 /
  // REQ-6.1, REQ-6.3). Platform path ONLY — taken BEFORE prepare() because
  // prepare() itself spends on the platform key (it can invoke summarize()).
  // The non-billable `listModels` capability call above is allowed to precede
  // the gate; the invariant is "no SPEND before the gate". A failing gate throws
  // an AppError(402) BEFORE any SSE header → JSON envelope (REQ-6.4). The held
  // amount is threaded into the stream so non-debit exits release it and Task 14
  // reconciles it at the inserted-row debit. BYOK turns take no reservation.
  const billingMode: 'platform' | 'byok' = byok ? 'byok' : 'platform';
  // was-BYOK→platform fall-through: the user holds a BYOK key for a different
  // provider, but this turn resolved to the platform path (REQ-6.5).
  const fellThrough = !byok && ctx.hasAnyProviderKey;
  // Platform billing-mode marker (plan-tiers D10/D11): the explicit signal the
  // persist seam builds `persistTurn`'s `billing` arg from — set ONLY on the
  // platform path, undefined for BYOK. Distinct from `billingMode` above,
  // which feeds the client-facing BILLING_MODE notice ('platform' | 'byok')
  // and is untouched — an allowance turn still discloses mode:'platform' (a
  // credential-source disclosure, not a billing-mode one).
  let platformBillingMode: 'credits' | 'allowance' | undefined;
  let reservationHeld = 0n;
  // D17: true when this platform turn is credit-billed on the allowance model
  // while the allowance is exhausted — the free-taste→paying transition. The
  // `allowance_credits_fallback` event fires post-persist (on the non-deduped
  // done frame below), once per qualifying turn.
  let creditsFallbackTurn = false;
  if (!byok) {
    // L4 (plan-tiers D10; REQ-8.1/8.6/8.7): a platform turn is
    // allowance-eligible iff gating is enforced for this user, the turn runs
    // on the provider's designated allowance model, and the committed
    // allowance usage is below the tier's platformTurns limit. The
    // committed-count read carries the REQ-8.7 overshoot posture (in-flight
    // turns may pass, bounded by the per-user stream rate limiter). BYOK
    // turns never reach this block (REQ-8.3).
    const isAllowanceModel = modelId === ALLOWANCE_MODEL[providerId];
    let allowanceHeadroom = false;
    if (tierCtx.enforced && isAllowanceModel) {
      const used = await getAllowanceUsage(db, userId, PERIOD_KEY());
      allowanceHeadroom =
        tierCtx.limits.platformTurns === null || used < tierCtx.limits.platformTurns;
    }
    if (tierCtx.enforced && isAllowanceModel && allowanceHeadroom) {
      // Allowance path (REQ-8.1/8.6): subsidized — NO gateAndReserve, NO
      // reservation, NO Stripe requirement. The marker makes persistTurn
      // write a creditCost-0 usage record with the true rawCost and advance
      // both counters; the wallet is never touched.
      platformBillingMode = 'allowance';
    } else {
      // Credit path — byte-identical to the pre-allowance behaviour
      // (REQ-8.2/8.8), with the D12 enriched refusals wrapped around
      // gateAndReserve's 402s; `gateAndReserve` itself stays
      // allowance-ignorant.
      platformBillingMode = 'credits';
      // In this branch `enforced ∧ isAllowanceModel` implies the allowance is
      // exhausted (headroom would have taken the allowance path above).
      creditsFallbackTurn = tierCtx.enforced && isAllowanceModel;
      try {
        const reservation = await gateAndReserve(userId, providerId, modelId);
        reservationHeld = reservation.held;
      } catch (err) {
        // D12: enrich INSUFFICIENT_CREDITS with allowance context. Plain
        // INSUFFICIENT_CREDITS (gating off, or a non-allowance model with no
        // allowance headroom) and BILLING_NOT_AVAILABLE keep their exact
        // current meanings.
        if (err instanceof AppError && err.code === 'INSUFFICIENT_CREDITS' && tierCtx.enforced) {
          if (isAllowanceModel) {
            // Allowance model, headroom exhausted, credits insufficient.
            captureServerEvent('tier_limit_hit', {
              distinctId: userId,
              properties: { lever: 'platformTurns' },
            });
            throw new AppError(
              402,
              'ALLOWANCE_EXHAUSTED',
              `Your ${tierCtx.limits.platformTurns} free monthly turns on this model are used up and you're out of credits. Free turns reset at the start of next month (UTC).`,
            );
          }
          const used = await getAllowanceUsage(db, userId, PERIOD_KEY());
          if (tierCtx.limits.platformTurns === null || used < tierCtx.limits.platformTurns) {
            // Non-allowance model, credits insufficient, allowance headroom
            // exists — disclose the free option (REQ-8.9c).
            captureServerEvent('tier_limit_hit', {
              distinctId: userId,
              properties: { lever: 'platformTurns' },
            });
            throw new AppError(
              402,
              'INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE',
              `You're out of credits for this model, but free monthly turns are available on ${ALLOWANCE_MODEL[providerId]} — start a new conversation on that model, or add credits.`,
            );
          }
        }
        throw err;
      }
    }
  }

  // From here on a thrown error / prepare-internal non-debit exit MUST release
  // the hold (REQ-6.3). `released` guards exactly-once release.
  let released = reservationHeld <= 0n; // BYOK / allowance: nothing to release
  const releaseHold = async () => {
    if (released) return;
    released = true;
    await releaseReservation(userId, reservationHeld);
  };

  // prepare() runs the remaining pre-stream steps (5-9). Throws an AppError on
  // failure (caught by onError → JSON envelope); on success returns the
  // Prepared plus an idempotent releaseSlot the route MUST call in finally.
  // prepare() spends on the platform key (it may run summarize()), so a throw
  // here is a non-debit exit — release the hold before re-throwing (REQ-6.3).
  let prepareResult: Awaited<ReturnType<typeof prepare>>;
  try {
    prepareResult = await prepare({
      conversationId,
      userId,
      input: body,
      abortSignal,
      context: {
        providerId,
        modelId,
        providerModel,
        apiKey,
        // D10 (REQ-2.6): re-inline every history image pointer to inline bytes
        // ONCE, upfront, before the provider chain — the entire downstream chain
        // (redact/flatten/assemble + both adapters) then runs on narrow inline
        // parts unchanged. Inside this try so a throw releases the reservation.
        history: await resolveForProvider(ctx.history),
        persona: ctx.persona,
        personaId: ctx.personaId,
        reservationHeld,
        platformBillingMode,
      },
    });
  } catch (err) {
    await releaseHold();
    throw err;
  }
  const { prepared, releaseSlot } = prepareResult;

  try {
    if (prepared.kind === 'synthetic-done') {
      // Layer-2 dedupe hit (a non-debit success — prepare returned before any
      // provider call). Release the gate hold (Finding 1 / REQ-6.3), then emit a
      // single done frame and close.
      await releaseHold();
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            messageId: prepared.messageId,
            deduped: true,
            source: 'layer-2',
          }),
        });
      });
    }

    if (prepared.kind === 'error') {
      // prepare()-returned terminating error frame (CONVERSATION_TURN_TOO_LARGE,
      // incl. the pre-prepare summarize hard-stop). A non-debit exit — release
      // the hold (REQ-6.3) before runStreaming yields the error frame.
      await releaseHold();
    }

    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      // Route-side heartbeat (REQ-3.7): write a `:`-comment keepalive every
      // HEARTBEAT_MS of real-frame silence so proxy/LB idle timeouts (which
      // reset on any byte) don't drop a tool-silent window. Reset on every real
      // frame; cleared in finally. Concurrent with the for-await: writeSSE and
      // write both go through the WHATWG writer, which queues writes, so frames
      // cannot interleave mid-frame — only ordering is nondeterministic, which
      // is harmless for a data-less comment.
      // Billing-mode disclosure (wallet-billing REQ-6.5): the first frame on a
      // real stream tells the client whether this turn is platform-billed or
      // BYOK, and (when the user holds a key for a different provider) that a
      // BYOK→platform fall-through occurred.
      if (prepared.kind === 'stream') {
        await stream.writeSSE({
          event: 'notice',
          data: JSON.stringify({
            code: 'BILLING_MODE',
            mode: billingMode,
            ...(fellThrough ? { fellThrough: true } : {}),
          }),
        });
      }

      const heartbeat = setInterval(() => {
        void stream.write(HEARTBEAT_FRAME);
      }, HEARTBEAT_MS);
      try {
        for await (const frame of runStreaming(prepared)) {
          heartbeat.refresh(); // reset the silence window on every real frame
          await stream.writeSSE(frame);
          // D17: `allowance_credits_fallback` — post-persist (a non-deduped
          // done frame follows the committed persist+debit), on a
          // credit-billed platform turn on the allowance model while the
          // allowance is exhausted. A deduped replay was not billed this turn
          // and does not qualify; error exits yield no done frame.
          if (creditsFallbackTurn && frame.event === 'done') {
            const done = JSON.parse(frame.data) as { deduped?: boolean };
            if (done.deduped !== true) {
              captureServerEvent('allowance_credits_fallback', {
                distinctId: userId,
                properties: { provider: providerId, model: modelId },
              });
            }
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  } finally {
    releaseSlot(); // idempotent; only releases the slot, never the idempotency entry
  }
}
