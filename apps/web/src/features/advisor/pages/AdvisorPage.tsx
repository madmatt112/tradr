// AdvisorPage — two-pane advisor chat surface (REQ-1.1, 1.4–1.8, 1.11).
//
// Left pane: ConversationList (Task 40). Right pane: Transcript (Task 41) over a
// Composer (Task 42). The page owns navigation and submission wiring; the child
// components stay route-agnostic.
//
// New-conversation flow (REQ-1.8): the page never navigates to `/advisor/{id}`
// before the server has confirmed the conversation exists. The first send on a
// new conversation streams against the `new` endpoint, and the transcript is
// mounted against that placeholder id so the user's message and the streaming
// reply show up immediately. Once the stream and the conversation-list refetch
// confirm the server-assigned id, the store entry is adopted under that id and
// the URL is replaced (replace: true) so the back button never lands on
// `/advisor/new` and the finished turn stays on screen while the persisted
// messages load.
//
// This module is lazy-loaded at the route boundary (the route files import it
// via React.lazy) so the advisor bundle — and the syntax highlighter it pulls in
// — never lands in the initial app bundle (design §Performance).

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PanelLeft, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { BillingModel } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { DrawerToggle } from '@/components/layout/DrawerToggle';
import { Button } from '@/components/ui/button';

import { hasAllowanceHeadroom } from '../../billing/tier-usage';
import { useTierState } from '../../billing/useTierState';
import { billingKeys, useBillingConfig } from '../../billing/useWalletBalance';
import { AdvisorContextStrip } from '../components/AdvisorContextStrip';
import { Composer, type ComposerSubmit } from '../components/Composer';
import { ConversationList } from '../components/ConversationList';
import { PlatformModelPicker } from '../components/PlatformModelPicker';
import { Transcript } from '../components/Transcript';
import { useAdvisorStream } from '../hooks/useAdvisorStream';
import { useConversations } from '../hooks/useConversations';
import { useListPersonas } from '../hooks/usePersonas';
import { useProviderKeys } from '../hooks/useProviderKeys';
import { NEW_CONVERSATION_ID, useStreamStore } from '../stores/stream.store';

// System fallback persona id (REQ-7 default-resolution order). Used only when the
// user has not marked a default and no persona is otherwise selectable.
const SYSTEM_DEFAULT_PERSONA_ID = 'default-trading-advisor';

export interface AdvisorPageProps {
  /** Conversation id from the route, or null on `/advisor` and `/advisor/new`. */
  conversationId: string | null;
  /** True on the `/advisor/new` route — forces the empty new-conversation pane. */
  isNew?: boolean;
}

export function AdvisorPage({ conversationId, isNew = false }: AdvisorPageProps) {
  const navigate = useNavigate();
  const conversations = useConversations();
  const personasQuery = useListPersonas();
  const providerKeys = useProviderKeys();
  const billingConfig = useBillingConfig();
  const tierQuery = useTierState();
  const stream = useAdvisorStream();
  const queryClient = useQueryClient();
  // Whether a first turn is in flight (or finished / failed) under the
  // new-conversation placeholder — mounts the transcript on the new pane.
  const newTurnActive = useStreamStore(
    (s) => (s.byConversation[NEW_CONVERSATION_ID]?.kind ?? 'idle') !== 'idle',
  );
  const adoptStream = useStreamStore((s) => s.adopt);
  const resetStream = useStreamStore((s) => s.reset);

  const [drawerOpen, setDrawerOpen] = useState(false);
  // The clientMessageId of the in-flight submission, retained so the retry button
  // re-sends with the SAME id (REQ-1.7 / REQ-3.12).
  const [lastSubmit, setLastSubmit] = useState<ComposerSubmit | null>(null);
  // The platform provider/model chosen in the picker for a no-BYOK new platform
  // conversation (wallet-billing REQ-4.3). Null until the user picks one.
  const [platformOverride, setPlatformOverride] = useState<BillingModel | null>(null);

  const personas = personasQuery.data?.items ?? [];
  const hasProviderKey = (providerKeys.data?.items.length ?? 0) > 0;

  // Platform billing is enabled for this instance (wallet-billing REQ-4.3). The
  // flag is authoritative — sourced from GET /api/billing/config, never guessed.
  const platformEnabled = billingConfig.data?.enabled === true;
  const platformModels = billingConfig.data?.models ?? [];
  // A user with no BYOK key can still start a conversation when platform billing
  // is enabled — the no-BYOK platform entry path. When neither holds, today's
  // "configure a key" empty state stands (REQ-10.3).
  const canStartConversation = hasProviderKey || platformEnabled;
  // The picker (and the providerOverride send) is the no-BYOK platform path ONLY:
  // BYOK users keep today's behavior with no picker and no override.
  const usePlatformPicker = !hasProviderKey && platformEnabled;

  // Plan-tier state (plan-tiers Component 12): drives allowance marking,
  // preselection, allowance-first ordering, and the composer's disclosure
  // hints. All of it activates only when the config marks an allowance model
  // (itself gating-gated, D16) AND tier state shows headroom — on a self-host
  // neither holds and nothing changes.
  const tierState = tierQuery.data;
  const allowanceEntry = platformModels.find((m) => m.allowance === true);
  const allowanceHeadroom = hasAllowanceHeadroom(tierState);

  // Default persona to hand the Composer. The Composer does NOT auto-select, so
  // the page must always pass a concrete id (carry-over from Task 42 review):
  //  1) the user's default persona, else
  //  2) the built-in "Trading Advisor", else
  //  3) the first persona in the list — never undefined when a list exists.
  const defaultPersonaId = useMemo(() => {
    if (personas.length === 0) return undefined;
    const userDefault = personas.find((p) => p.isDefault);
    if (userDefault) return userDefault.id;
    const builtin = personas.find((p) => p.id === SYSTEM_DEFAULT_PERSONA_ID);
    if (builtin) return builtin.id;
    return personas[0].id;
  }, [personas]);

  // Reset the retained submission whenever the active conversation changes so a
  // retry never re-sends a message belonging to a different conversation.
  useEffect(() => {
    setLastSubmit(null);
    setPlatformOverride(null);
  }, [conversationId, isNew]);

  const activeId = isNew ? null : conversationId;

  // Once a real conversation is on screen a finished placeholder entry has
  // served its purpose (it was adopted under the real id before navigation);
  // clear it so the next visit to the new pane starts empty. A turn still in
  // flight is left alone — the user may have clicked another conversation while
  // it streams, and it is adopted and navigated to when it completes.
  useEffect(() => {
    if (activeId === null) return;
    const kind = useStreamStore.getState().byConversation[NEW_CONVERSATION_ID]?.kind;
    if (kind === 'pending' || kind === 'streaming') return;
    resetStream(NEW_CONVERSATION_ID);
  }, [activeId, resetStream]);

  // REQ-8.9b preselect: a no-BYOK user with allowance headroom gets the
  // allowance model preselected instead of an empty picker (an empty start
  // auto-refuses a zero-credit first turn with INSUFFICIENT_CREDITS on the most
  // expensive model). Empty-until-loaded: while the tier query is in flight the
  // picker stays empty exactly as today, and a manual pick is never overridden.
  useEffect(() => {
    if (platformOverride !== null) return;
    if (!usePlatformPicker || activeId !== null) return;
    if (!allowanceEntry || !allowanceHeadroom) return;
    setPlatformOverride(allowanceEntry);
  }, [platformOverride, usePlatformPicker, activeId, allowanceEntry, allowanceHeadroom]);

  const runSubmit = async (submission: ComposerSubmit) => {
    setLastSubmit(submission);
    const personaId = submission.personaId ?? defaultPersonaId;
    const targetId = activeId ?? NEW_CONVERSATION_ID;

    // Capture the known conversation ids BEFORE streaming so we can identify the
    // newly-created conversation by set-difference after the refetch (avoids the
    // "navigate to items[0]" heuristic, which can land on the wrong conversation
    // if the list reorders between send and refetch).
    const knownIds =
      activeId === null ? new Set((conversations.data?.items ?? []).map((c) => c.id)) : null;

    // providerOverride is sent ONLY on a NEW platform conversation entered via the
    // no-BYOK picker (REQ-4.3/4.4). Existing conversations keep their pinned
    // provider/model (no override); BYOK users send no override at all.
    const providerOverride =
      activeId === null && usePlatformPicker && submission.providerOverride
        ? submission.providerOverride
        : undefined;

    try {
      await stream.mutateAsync({
        conversationId: targetId,
        clientMessageId: submission.clientMessageId,
        text: submission.text,
        attachments: submission.attachments,
        personaId,
        ...(providerOverride ? { providerOverride } : {}),
      });
    } catch {
      // Errors surface through the stream store → Transcript retry placeholder.
      // The mutation is retry: 0; we never auto-retry here (task restriction).
      return;
    } finally {
      // THE one billingKeys.tier() invalidation seam (plan-tiers Component 12):
      // this page owns the stream lifecycle, so headroom freshness after every
      // committed turn and every 402-family refusal lives HERE — never in the
      // Composer (it only renders refusals) and never in useAdvisorStream, so
      // no second copy drifts.
      void queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
    }

    // New-conversation flow: only AFTER the server confirms the conversation does
    // the URL change to /advisor/{id} (REQ-1.8). useAdvisorStream only invalidates
    // the `conversation` detail key — never the list key — so this explicit
    // refetch() is what surfaces the server-assigned id. Do NOT delete it. We
    // locate the new id by set-difference against the ids known before the send,
    // so a list reorder can't make us navigate to the wrong conversation.
    if (knownIds !== null) {
      const refetched = await conversations.refetch();
      const newIds = (refetched.data?.items ?? []).filter((c) => !knownIds.has(c.id));
      if (newIds.length === 1) {
        // Carry the finished turn over to the real id so the transcript there
        // renders it straight away instead of waiting on the detail query.
        adoptStream(NEW_CONVERSATION_ID, newIds[0].id);
        await navigate({
          to: '/advisor/$id',
          params: { id: newIds[0].id },
          replace: true,
        });
      } else {
        toast.error("Couldn't open the new conversation. Refresh and try again.");
      }
    }
  };

  const onRetry = () => {
    if (lastSubmit) void runSubmit(lastSubmit);
  };

  const onSelect = (id: string) => {
    setDrawerOpen(false);
    void navigate({ to: '/advisor/$id', params: { id } });
  };

  const onNewConversation = () => {
    setDrawerOpen(false);
    void navigate({ to: '/advisor/new' });
  };

  // The picker only renders on a NEW conversation (activeId === null): existing
  // conversations keep their pinned provider/model.
  const showPlatformPicker = usePlatformPicker && activeId === null;
  // In platform-picker mode the user must pick a priced model before sending — it
  // is the required contract for a no-BYOK new platform conversation (REQ-4.3).
  const awaitingPlatformPick = showPlatformPicker && platformOverride === null;
  const composerDisabled = !canStartConversation || awaitingPlatformPick || stream.isPending;
  const errorCode =
    stream.error instanceof Error && 'code' in stream.error
      ? (stream.error as { code?: string }).code
      : undefined;

  const hasConversations = (conversations.data?.items.length ?? 0) > 0;

  return (
    <div data-slot="advisor-page" className="flex h-[calc(100vh-3rem)] flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Toggle conversation list"
          className="cursor-pointer md:hidden"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <PanelLeft className="size-4" />
        </Button>
        {/* The desk header grammar (task 8 re-skins the rest of this row). */}
        <h1 className="flex items-baseline gap-1.5 font-mono text-sm font-semibold lowercase">
          <span aria-hidden="true" className="text-primary">
            ▴
          </span>
          Advisor
        </h1>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto cursor-pointer"
          onClick={onNewConversation}
        >
          New conversation
        </Button>
        {/* The app-wide drawer opener — the advisor keeps its own header row,
            so it carries the slot. */}
        <DrawerToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left pane — collapses to a drawer under md (REQ-1.1). */}
        <aside
          data-testid="conversation-pane"
          className={`${
            drawerOpen ? 'block' : 'hidden'
          } w-72 shrink-0 overflow-y-auto border-r md:block`}
        >
          <ConversationList activeId={activeId} onSelect={onSelect} />
        </aside>

        {/* Right pane — transcript + composer (or empty/no-key state). */}
        <section className="flex min-w-0 flex-1 flex-col">
          {canStartConversation ? (
            <AdvisorContextStrip
              conversation={
                activeId !== null
                  ? (conversations.data?.items.find((c) => c.id === activeId) ?? null)
                  : null
              }
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {activeId ? (
              <Transcript conversationId={activeId} onRetry={onRetry} />
            ) : canStartConversation && newTurnActive ? (
              <Transcript conversationId={NEW_CONVERSATION_ID} onRetry={onRetry} />
            ) : !canStartConversation ? (
              <div className="p-6" data-testid="no-key-banner">
                <EmptyState
                  title="No provider key configured"
                  description="Add a provider API key in Settings → Advisor to start chatting."
                  action={
                    <Button
                      type="button"
                      className="cursor-pointer"
                      onClick={() => void navigate({ to: '/settings/advisor' })}
                    >
                      Go to Settings → Advisor
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="p-6" data-testid="empty-state">
                <EmptyState
                  title={
                    isNew || !hasConversations
                      ? 'Start a conversation with the Tradr Advisor.'
                      : 'Select a conversation'
                  }
                  icon={<Sparkles className="size-6" />}
                />
              </div>
            )}
          </div>

          {canStartConversation && (activeId || isNew || !hasConversations) ? (
            <>
              {showPlatformPicker && platformModels.length > 0 ? (
                <PlatformModelPicker
                  models={platformModels}
                  value={platformOverride}
                  onChange={setPlatformOverride}
                  disabled={stream.isPending}
                  allowanceHeadroom={allowanceHeadroom}
                />
              ) : null}
              <Composer
                personas={personas}
                defaultPersonaId={defaultPersonaId}
                visionEnabled={false}
                disabled={composerDisabled}
                pending={stream.isPending}
                errorCode={errorCode}
                tierState={tierState}
                remedies={{
                  buyCredits: platformEnabled,
                  upgrade: billingConfig.data?.subscription?.purchasable === true,
                }}
                allowanceModel={allowanceEntry?.model}
                pinnedConversation={activeId !== null}
                providerOverride={
                  showPlatformPicker && platformOverride ? platformOverride : undefined
                }
                onSubmit={(submission) => void runSubmit(submission)}
                onStartNewConversation={onNewConversation}
              />
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default AdvisorPage;
