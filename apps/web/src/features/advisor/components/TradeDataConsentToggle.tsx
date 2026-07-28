// TradeDataConsentToggle — the trade-data consent surface for Settings → Advisor
// (design §Component 9; REQ-10.1b, REQ-10.2, REQ-10.3, REQ-10.6).
//
// Behaviour:
//   - Defaults OFF (REQ-10.1b); reads/writes the flag via useTradeDataConsent.
//   - Toggling persists immediately with an optimistic update + rollback on
//     error (REQ-10.3) — handled in the hook.
//   - Progressive-disclosure copy (REQ-10.2): a one-line summary at the toggle
//     plus an expandable "What this means" panel covering (a)-(e). The copy does
//     NOT lean on "read-only" as a safety claim.
//   - Reliability/cost disclosure (REQ-10.6).

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  useSetTradeDataConsent,
  useTradeDataConsent,
} from '@/features/advisor/hooks/useTradeDataConsent';

export function TradeDataConsentToggle() {
  const { data, isLoading, isError } = useTradeDataConsent();
  const setConsent = useSetTradeDataConsent();
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  const consent = data?.consent ?? false;

  const onToggle = (next: boolean) => {
    setConsent.mutate(next, {
      onError: () => {
        toast.error("Couldn't update trade-data access. Try again.");
      },
    });
  };

  return (
    <Card data-testid="trade-data-consent-card">
      <CardHeader>
        <CardTitle>Trade-data access</CardTitle>
        <CardDescription>
          Lets the advisor read summaries of your positions, accounts and P&amp;L and send them to
          your LLM provider.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isError && (
          <p className="text-sm text-destructive">Couldn't load trade-data access. Try again.</p>
        )}

        <div className="flex items-center gap-3">
          <Switch
            id="trade-data-consent"
            checked={consent}
            onCheckedChange={onToggle}
            disabled={isLoading}
            aria-label="Trade-data access"
          />
          <Label htmlFor="trade-data-consent" className="cursor-pointer">
            {consent ? 'On' : 'Off'}
          </Label>
        </div>

        <Collapsible open={disclosureOpen} onOpenChange={setDisclosureOpen}>
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-sm font-medium text-foreground hover:underline">
            What this means
            <ChevronDown
              className={`size-4 transition-transform ${disclosureOpen ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                The advisor reads summaries of your positions, accounts, and P&amp;L and sends them
                to your LLM provider.
              </li>
              <li>
                Over a conversation, potentially your full history may reach the provider. The
                per-reply limit caps how much one reply sends — not your total over the
                conversation.
              </li>
              <li>
                While access is on, automatic summarization re-sends trade figures on your own
                provider key. Turning access off stops this.
              </li>
              <li>
                Snapshots and figures the advisor restated in its replies persist after you turn
                access off, until you delete the conversation.
              </li>
              <li>
                Turning consent off stops new reads and removes stored structured trade-data and the
                separated figures in summaries from what's sent to the provider. It cannot remove
                figures the advisor already wrote into its replies, and may not catch figures
                referenced inside summary text — to fully remove trade data, delete the
                conversation.
              </li>
            </ul>
            <p className="pt-3 text-xs text-muted-foreground">
              Turning access on lets the advisor send your trade data to a third-party provider.
              This is a privacy decision: it is not made safe by the data being read-only.
            </p>
          </CollapsibleContent>
        </Collapsible>

        <div
          className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
          data-testid="reliability-note"
        >
          <p className="font-medium text-foreground">Reliability &amp; cost</p>
          <ul className="mt-1 list-disc space-y-1 pl-6">
            <li>A reply may come back incomplete when the advisor hits its tool-use limit.</li>
            <li>Tool use can be temporarily rate-limited.</li>
            <li>One very large turn can still require starting a new conversation.</li>
            <li>
              Disconnecting mid-analysis discards that turn (no saved answer) but still costs
              provider tokens.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
