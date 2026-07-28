// Advisor persistence orchestration (design §Component 4).
//
// Implements REQ-4 (post-completion atomic writes) and REQ-3.12 Layer 1 (the
// ON CONFLICT CTE dedupe). The business logic lives here; the single-statement
// Drizzle wrappers live in `advisor.query.ts`.
//
// This module owns transaction boundaries only — it never emits SSE / HTTP
// shapes. The streaming orchestrator translates the returned discriminated
// union (and any thrown InvariantViolationError) into wire frames.

import { sql } from 'drizzle-orm';

import type { ProviderId, StoredContentPart } from '@tradr/shared';

import { db } from '@/db';
import {
  currentPeriodKeyUtc,
  incrementImageCounter,
  incrementTurnCounter,
} from '@/features/admin/gating.query';
import {
  applyBalanceDelta,
  getWalletForUpdate,
  insertUsageRecord,
} from '@/features/billing/billing.query';
import { releaseReservation } from '@/features/billing/billing.service';
import { priceTurnUsageParts } from '@/features/billing/pricing';
import { logger } from '@/lib/logger';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import { InvariantViolationError } from './advisor.errors';
import {
  findPairedAssistantMessage,
  insertAssistantMessage,
  insertConversation,
  insertUserMessageIdempotent,
  touchConversation,
  touchProviderKeyLastUsed,
} from './advisor.query';
import type { CanonicalPart } from './providers/adapter';

export interface PersistTurnArgs {
  /** Existing conversation id, or `null` on the new-conversation path. */
  conversationId: string | null;
  userId: string;
  // Widened to StoredContentPart[] (CanonicalPart ⊆ StoredContentPart, Task 4)
  // so the write seam can pass pointer markers on the object-storage path; the
  // inline base64 path is unchanged (a CanonicalPart[] is a valid value here).
  userMessage: { contentParts: StoredContentPart[]; clientMessageId: string };
  assistantMessage: {
    /**
     * The full ordered turn output. After the tool-loop rewrite this is the
     * complete text/tool_call/tool_result part sequence (a `CanonicalPart[]`),
     * persisted as the single assistant row's `content_parts` (design §4.3 /
     * REQ-4.3). A conversation-only turn is just `[{ type: 'text', text }]`.
     */
    contentParts: CanonicalPart[];
    promptTokens: number | null;
    completionTokens: number | null;
  };
  providerId: ProviderId;
  modelId: string;
  personaId: string | null;
  /**
   * Platform-turn billing context (wallet-billing Component 7 / REQ-5.3-5.5,
   * REQ-9.2; plan-tiers D11). Present ONLY on a platform turn — BYOK turns
   * pass nothing (REQ-5.7). When present, the turn counter, `usage_record`
   * insert, and (credits mode) debit happen on the `kind:'inserted'` branch
   * inside the SAME transaction as the message writes; the `kind:'deduped'`
   * retry releases the reservation instead of debiting (REQ-9.4). The
   * accumulator shape mirrors `MeteredUsage` from `streaming.ts` (declared
   * locally to avoid an import cycle).
   */
  billing?: {
    userId: string;
    providerId: ProviderId;
    model: string;
    /**
     * Plan-tiers D11: `'credits'` = wallet-billed exactly as before (lock +
     * debit + reservation reconcile); `'allowance'` = subsidized free-tier
     * turn — usage record with true `rawCost` but `creditCost: 0n`
     * (REQ-8.5), NO wallet lock, NO balance delta, no reservation held.
     */
    mode: 'credits' | 'allowance';
    /** Cumulative metered tokens across every platform call in the turn. */
    usage: { inputTokens: number; outputTokens: number };
    /**
     * Gate-time reservation hold (micro-USD) to reconcile at the credits
     * debit. Always `0n` in allowance mode (no reservation is taken, D10).
     */
    reservationHeld: bigint;
  };
}

export type PersistTurnResult =
  | { kind: 'inserted'; conversationId: string; userMessageId: string; assistantMessageId: string }
  | { kind: 'deduped'; conversationId: string; assistantMessageId: string };

/** @deprecated Use {@link PersistTurnArgs}. Retained until the task-25 loop rewrite. */
export type PersistExchangeArgs = PersistTurnArgs;
/** @deprecated Use {@link PersistTurnResult}. Retained until the task-25 loop rewrite. */
export type PersistExchangeResult = PersistTurnResult;

/** First text part's text, or `null` when the message has no text part. */
function firstTextPart(parts: StoredContentPart[]): string | null {
  for (const part of parts) {
    if (part.type === 'text') {
      return part.text;
    }
  }
  return null;
}

/** Per-image token cost for the local fallback estimate (mirrors cap-check.ts). */
const FALLBACK_IMAGE_TOKENS = 1500;

/**
 * Free, local, network-free token estimate over a `CanonicalPart[]` — mirrors
 * the conservative `~chars/3 + image cost` heuristic in `cap-check.ts`
 * (`fallbackTokens`). Used by the metering debit (Component 7 / REQ-5.6) as the
 * estimate-fallback when the provider reported NO usage for a metered platform
 * turn, so the user is charged a real (estimated) cost rather than 0. Counts
 * text length, a `tool_call`'s name + serialized arguments, a `tool_result`'s
 * serialized content, and a flat per-image cost. Returns 0 for empty input.
 */
function estimatePartsTokens(parts: StoredContentPart[]): number {
  let chars = 0;
  let imageCount = 0;
  for (const part of parts) {
    if (part.type === 'text') chars += part.text.length;
    else if (part.type === 'image') imageCount += 1;
    else if (part.type === 'tool_call')
      chars += part.name.length + JSON.stringify(part.arguments ?? {}).length;
    else if (part.type === 'tool_result') chars += JSON.stringify(part.content ?? {}).length;
  }
  return Math.ceil(chars / 3) + FALLBACK_IMAGE_TOKENS * imageCount;
}

/**
 * Atomically persist a completed turn (one user message + one assistant
 * message) and, post-commit, bump the provider key's `last_used_at`.
 *
 * The assistant message holds the full ordered turn output (text/tool_call/
 * tool_result parts) in its single `content_parts` array — still EXACTLY one
 * user row + one assistant row, never any 'tool' rows (design §4.3 / REQ-4.3,
 * REQ-4.5). Because only one assistant row is written per `clientMessageId`,
 * the Layer-1 idempotency CTE, the single-row `findPairedAssistantMessage`
 * lookup, and `advisor_messages_assistant_pair_uniq` are all preserved.
 *
 * REQ-4.2: user + assistant messages are written in one transaction; no
 * half-saved turns. REQ-3.12 Layer 1: a duplicate `clientMessageId` is caught
 * by the partial-unique index via `ON CONFLICT DO NOTHING`, in which case the
 * existing paired assistant message id is returned (`kind: 'deduped'`).
 *
 * Mid-loop abort (REQ-3.8) never reaches this function — the orchestrator only
 * calls `persistTurn` once the turn has completed — so nothing persists on
 * abort.
 */
export async function persistTurn(args: PersistTurnArgs): Promise<PersistTurnResult> {
  const result = await withTransaction(db, async (tx) => {
    // The 30 s statement_timeout is REQ-4.9's PERSISTENCE_TIMEOUT budget. A
    // single SET LOCAL statement so it auto-cleans on COMMIT/ROLLBACK and the
    // pooled connection returns clean (no multi-statement SET/UPDATE/RESET).
    await tx.execute(sql`SET LOCAL statement_timeout = 30000`);

    // Step 1: ensure the conversation row exists.
    let conversationId = args.conversationId;
    if (conversationId === null) {
      const titleSeed = (firstTextPart(args.userMessage.contentParts) ?? '').slice(0, 60);
      conversationId = await insertConversation(tx, {
        userId: args.userId,
        title: titleSeed,
        personaId: args.personaId,
        providerId: args.providerId,
        model: args.modelId,
      });
    }

    // Step 2: idempotency-checked user-message insert (CTE; ON CONFLICT
    // predicate matches the advisor_messages_idem index WHERE verbatim).
    const { userMessageId, wasInserted } = await insertUserMessageIdempotent(tx, {
      conversationId,
      contentParts: args.userMessage.contentParts,
      clientMessageId: args.userMessage.clientMessageId,
    });

    if (!wasInserted) {
      // Layer-1 dedupe hit. The paired assistant row inherits the user row's
      // client_message_id, so this is a single-statement lookup with no
      // created_at ordering.
      const assistantMessageId = await findPairedAssistantMessage(tx, {
        conversationId,
        clientMessageId: args.userMessage.clientMessageId,
      });
      if (assistantMessageId === null) {
        // Invariant violation: the concurrency cap + idempotency peek should
        // guarantee the paired assistant row is visible by the time we observe
        // wasInserted = false. The orchestrator's outer catch converts this to
        // PERSISTENCE_FAILED.
        throw new InvariantViolationError(
          'advisor: paired assistant message missing after dedupe hit',
        );
      }
      return { kind: 'deduped' as const, conversationId, assistantMessageId };
    }

    // Step 3: assistant insert — inherits the user message's client_message_id.
    const assistantMessageId = await insertAssistantMessage(tx, {
      conversationId,
      contentParts: args.assistantMessage.contentParts,
      promptTokens: args.assistantMessage.promptTokens,
      completionTokens: args.assistantMessage.completionTokens,
      clientMessageId: args.userMessage.clientMessageId,
    });

    // Step 4: bump conversation updated_at.
    await touchConversation(tx, conversationId);

    // All monthly counters key the PERSIST-TIME period (plan-tiers D11 — a
    // decision, not an accident): a turn gated in month M whose long stream
    // persists in M+1 counts against M+1. Benign in both billing modes.
    const periodKey = currentPeriodKeyUtc();

    // plan-tiers REQ-9.1: committed image counter — ALL credential sources
    // (BYOK included), so it lives OUTSIDE the billing block. Inserted branch
    // only (the deduped retry returned above, so replays never double-count)
    // and unconditional — counting runs even with FEATURE_GATING=false
    // (counting is not a limit). Placed with the turn counter BEFORE any
    // `wallets` FOR UPDATE so wallets stays the LAST lock (structure.md).
    const imageCount = args.userMessage.contentParts.filter((p) => p.type === 'image').length;
    if (imageCount > 0) {
      await incrementImageCounter(tx, args.userId, periodKey, imageCount);
    }

    // Step 5 (wallet-billing Component 7 / REQ-5.3-5.5, REQ-9.2; plan-tiers
    // D11): on a platform turn, count it and record its complete metered usage
    // atomically with the message writes — ONE transaction, so a recorded usage
    // charge always has a matching balance debit and vice versa (no charge
    // without debit, no debit without record). Bound to the `inserted` branch
    // ONLY: a deduped retry (handled above) never debits (REQ-9.4). BYOK turns
    // pass no `billing` arg, so this is skipped entirely (REQ-5.7) — from
    // plan-tiers on, BYOK turns increment NO turn counter (REQ-8.3).
    if (args.billing) {
      const { userId, providerId, model, mode, usage, reservationHeld } = args.billing;

      // plan-tiers REQ-8.3: committed-turn counter — PLATFORM turns only. One
      // upsert sets `turn_count` and, on a within-allowance turn, also
      // `allowance_turns` (D11). Acquired BEFORE the wallets lock (lock order).
      await incrementTurnCounter(tx, userId, periodKey, { allowance: mode === 'allowance' });

      // Lock the wallet row LAST among this transaction's locks (the lock-order
      // note): serializes against concurrent debits/credits so no lost update.
      // The row exists because gateAndReserve `ensureWallet`'d it pre-stream.
      // Allowance mode (D11) takes NO wallet lock — nothing is debited, and no
      // reservation was taken (D10), so there is nothing to serialize against.
      if (mode === 'credits') {
        await getWalletForUpdate(tx, userId);
      }

      // Estimate-fallback for a provider-reported-no-usage turn (REQ-5.6 /
      // Component 7). The accumulator only sums concrete provider `usage` events;
      // if a metered platform turn produced an assistant response but the provider
      // reported no usage, the captured count is 0 and pricing 0/0 would charge
      // the user nothing for a real turn (a silent undercharge). So when a
      // dimension is missing/zero we substitute the free, network-free local
      // estimate (`estimatePartsTokens`, mirroring cap-check.ts's heuristic):
      //   - output ← the generated assistant message text being persisted;
      //   - input  ← the user message that drove this turn. This is a PARTIAL
      //     signal: prior conversation history is not available at the persist
      //     site, so the input estimate covers only this turn's user message and
      //     under-counts a long thread. It is a documented approximation — better
      //     than charging 0. CAPTURED usage is always preferred: only the zero/
      //     missing dimension is estimated (if input was captured but output
      //     wasn't, only output is estimated, and vice versa).
      // Never crash: if estimation throws, charge on the captured counts and WARN
      // (do not silently 0 a real turn).
      let inputTokens = usage.inputTokens;
      let outputTokens = usage.outputTokens;
      try {
        if (outputTokens <= 0)
          outputTokens = estimatePartsTokens(args.assistantMessage.contentParts);
        if (inputTokens <= 0) inputTokens = estimatePartsTokens(args.userMessage.contentParts);
      } catch (err) {
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
        logger.warn('advisor metering estimate failed — charging captured usage only', {
          userId,
          providerId,
          model,
          capturedInput: usage.inputTokens,
          capturedOutput: usage.outputTokens,
          error: (err as Error).message,
        });
      }

      // The model is priced (gated at admission, REQ-6.1), so pricing cannot
      // throw `UnpricedModelError` under normal flow; a pricing/metering
      // error rolls back the whole tx with the message writes (REQ-9.5 →
      // PERSISTENCE_* frame). `priceTurnUsageParts` yields the charged
      // creditCost (byte-identical to priceTurnUsage) PLUS the pre-markup
      // rawCost persisted as-charged on the usage record (admin-platform
      // REQ-4.2 option (i)).
      const { rawCost, creditCost } = priceTurnUsageParts({
        provider: providerId,
        model,
        inputTokens,
        outputTokens,
      });

      // plan-tiers REQ-8.5: an allowance turn records the TRUE rawCost (the
      // subsidized turn stays admin-cost-visible) with `creditCost: 0n` — the
      // zero-credit row IS the "subsidized" marker.
      const usageRecordId = await insertUsageRecord(tx, {
        userId,
        conversationId,
        messageId: assistantMessageId,
        providerId,
        model,
        inputTokens: BigInt(inputTokens),
        outputTokens: BigInt(outputTokens),
        creditCost: mode === 'allowance' ? 0n : creditCost,
        rawCost,
      });

      // Credits mode only (D11): allowance turns debit nothing and have no
      // reservation to reconcile.
      if (mode === 'credits') {
        await applyBalanceDelta(tx, userId, {
          deltaBalance: -creditCost,
          // Reconcile the gate hold ONLY on this inserted-debit path; the deduped
          // path releases it standalone (REQ-6.3 / REQ-9.4).
          deltaReserved: -reservationHeld,
          kind: 'debit',
          amount: -creditCost,
          reference: { usageRecordId },
        });
      }
    }

    return {
      kind: 'inserted' as const,
      conversationId,
      userMessageId,
      assistantMessageId,
    };
  });

  // advisor_conversation_started — fire-and-forget business event AFTER the
  // persistence tx commits (design Component 4, REQ-4.2/4.4), gated on the
  // new-conversation signal: args.conversationId === null means insertConversation
  // ran inside the tx above. Off the held-connection/SSE window; the inner guard
  // keeps a telemetry fault from ever failing the persisted turn.
  if (args.conversationId === null) {
    try {
      captureServerEvent('advisor_conversation_started', { distinctId: args.userId });
    } catch {
      // ignore — capture is fire-and-forget
    }
  }

  // Deduped retry never double-charges (wallet-billing Finding 1 / REQ-9.4): a
  // Layer-1 `clientMessageId` replay returns BEFORE the assistant write, so it
  // persists no row to attach a debit (or a reserved-reconciliation) to and the
  // turn it duplicates was already charged. The debit is bound to the `inserted`
  // branch only; here we just RELEASE the gate hold this retry took, as a bounded
  // standalone wallet update (no-op when held ≤ 0). Task 13 releases on every
  // OTHER non-debit exit, so the dedupe arm is the one path it intentionally
  // leaves for `persistTurn` — releasing here does not double-release.
  if (result.kind === 'deduped' && args.billing) {
    await releaseReservation(args.billing.userId, args.billing.reservationHeld);
  }

  // Post-commit (REQ-6.6): bump last_used_at in its OWN one-statement
  // transaction so SET LOCAL auto-cleans regardless of outcome. Non-fatal —
  // a failure here never affects the persisted exchange.
  try {
    await withTransaction(db, async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
      await touchProviderKeyLastUsed(tx, {
        userId: args.userId,
        providerId: args.providerId,
      });
    });
  } catch (err) {
    logger.warn('last_used_at update failed (non-fatal)', {
      userId: args.userId,
      providerId: args.providerId,
      error: (err as Error).message,
    });
  }

  return result;
}

/**
 * @deprecated Thin alias for {@link persistTurn}, kept only so the pre-loop
 * single-call streaming flow stays green until the task-25 loop rewrite swaps
 * the call site over to `persistTurn` directly.
 */
export const persistExchange = persistTurn;
