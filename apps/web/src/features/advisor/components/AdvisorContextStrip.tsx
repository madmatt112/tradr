import { Link } from '@tanstack/react-router';

import type { ProviderId } from '@tradr/shared';

import { useTradeDataConsent } from '../hooks/useTradeDataConsent';

// The desk chat's context strip (visual-redesign task 8): one slim mono line
// that says what the advisor can read and whose model is answering — both
// bound to data the app already holds. The consent flag is the REAL
// trade-data consent (REQ-10.3), revocable in Settings → Advisor; the model
// chip is the conversation's own pinned provider/model.
//
// SCOPE, logged: the mock drew per-category read access (positions ✓
// balances ✓ chart uploads ✓). The product has ONE consent flag covering
// trade data, so the strip says exactly that and no more — inventing
// per-category state the backend doesn't track would be a lie in chrome.
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

export function AdvisorContextStrip({
  conversation,
}: {
  /** The active conversation's pinned provider/model, if one is open. */
  conversation?: { providerId: ProviderId; model: string } | null;
}) {
  const consent = useTradeDataConsent();
  const granted = consent.data?.consent;

  return (
    <div
      data-testid="advisor-context-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline px-4 py-1.5 font-mono text-xs text-muted-foreground"
    >
      <span>
        {granted === undefined ? (
          'advisor access…'
        ) : granted ? (
          <>
            advisor can read: <span className="text-foreground">trade data ✓</span>
          </>
        ) : (
          'advisor reads no trade data'
        )}{' '}
        ·{' '}
        <Link to="/settings/advisor" className="cursor-pointer underline underline-offset-2">
          {granted ? 'revocable in settings' : 'enable in settings'}
        </Link>
      </span>
      {conversation ? (
        <span className="ml-auto inline-flex items-center rounded-full border border-hairline px-2.5 py-0.5">
          {PROVIDER_LABELS[conversation.providerId] ?? conversation.providerId} ·{' '}
          {conversation.model}
        </span>
      ) : null}
    </div>
  );
}

export default AdvisorContextStrip;
