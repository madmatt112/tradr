// BillingPanel — wallet balance card + credit-pack picker (design §Component 8;
// REQ-2.2/7.3/7.5).
//
// The balance is a credit COUNT (1 credit = 1 micro-USD), with an optional
// approximate USD equivalent derived from that constant — NEVER labeled
// displayCurrency. Pack prices are fiat, shown via formatCurrency(priceMinor/100).

import { useState } from 'react';
import { toast } from 'sonner';

import type { CreditPack } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

import { useCreateCheckout } from './useCreateCheckout';
import { useWalletBalance } from './useWalletBalance';

// 1 credit = 1 micro-USD (design §Component 3). Used ONLY to show an approximate
// USD equivalent of a credit count — the credit unit itself is never currency.
const MICRO_USD_PER_USD = 1_000_000;

// Approximate USD equivalent of a credit-unit string, without coercing the raw
// magnitude through a lossy float (we divide as a Number only for display). This
// is an APPROXIMATION display, independent of the credit-count figure; it routes
// through lib/format's canonical USD Intl shape (R5.1) rather than a bespoke Intl.
function approxUsd(credits: string): string {
  const usd = Number(credits) / MICRO_USD_PER_USD;
  return formatCurrency(usd, 'USD');
}

function PackCard({
  pack,
  onBuy,
  pending,
}: {
  pack: CreditPack;
  onBuy: (packId: string) => void;
  pending: boolean;
}) {
  return (
    <Card data-testid={`credit-pack-${pack.id}`}>
      <CardHeader>
        <CardTitle>{pack.label}</CardTitle>
        <CardDescription>{pack.credits} credits</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">
          {formatCurrency(pack.priceMinor / 100, pack.currency)}
        </span>
        <Button
          type="button"
          size="sm"
          className="cursor-pointer"
          disabled={pending}
          onClick={() => onBuy(pack.id)}
        >
          Buy credits
        </Button>
      </CardContent>
    </Card>
  );
}

export interface BillingPanelProps {
  packs: CreditPack[];
}

export function BillingPanel({ packs }: BillingPanelProps) {
  const balanceQuery = useWalletBalance();
  const checkout = useCreateCheckout();
  const [pendingPackId, setPendingPackId] = useState<string | null>(null);

  const onBuy = (packId: string) => {
    setPendingPackId(packId);
    checkout.mutate(
      { packId },
      {
        onError: () => {
          setPendingPackId(null);
          toast.error("Couldn't start checkout. Try again.");
        },
        // onSuccess redirects via window.location (useCreateCheckout) — no reset.
      },
    );
  };

  const balance = balanceQuery.data;

  return (
    <div className="space-y-6" data-testid="billing-panel">
      <Card data-testid="balance-card">
        <CardHeader>
          <CardTitle>Balance</CardTitle>
        </CardHeader>
        <CardContent>
          {balanceQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : balance ? (
            <div>
              <p className="text-2xl font-semibold">
                {/* Credit COUNT (neutral) — never gain/loss color, never displayCurrency. */}
                <Numeric value={balance.available} kind="integer" direction="none" /> credits
              </p>
              <p className="text-sm text-muted-foreground">≈ {approxUsd(balance.available)}</p>
            </div>
          ) : (
            <p className="text-sm text-destructive">Couldn&apos;t load balance.</p>
          )}
        </CardContent>
      </Card>

      <section className="space-y-4">
        <h3 className="text-base font-medium">Buy credits</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              onBuy={onBuy}
              pending={checkout.isPending && pendingPackId === pack.id}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
