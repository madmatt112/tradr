import { useState, type FormEvent } from 'react';

import type { CaptureEntryGreeksInput } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMarketDataKey } from '@/features/advisor/hooks/useMarketDataKey';

import { useCaptureEntryGreeks } from '../hooks/useOptionLifecycle';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface Props {
  position: { id: string; symbol: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Captures the Greeks a leg was entered with (design C7/C10): typed
 * Black-Scholes inputs, or — only once a market-data key is configured
 * (AC 6.2) — the chain's own Greeks for the contract. No volatility solver
 * is added (AC 6.5); Black-Scholes inputs are taken as given.
 */
export function EntryGreeksDialog({ position, open, onOpenChange }: Props) {
  const captureEntryGreeks = useCaptureEntryGreeks(position.id);
  const { data: keyStatus } = useMarketDataKey();
  const keyConfigured = keyStatus?.configured === true;

  const [mode, setMode] = useState<'black_scholes' | 'chain'>('black_scholes');
  const [volatility, setVolatility] = useState('');
  const [spot, setSpot] = useState('');
  const [rate, setRate] = useState('');
  const [dividendYield, setDividendYield] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    let payload: CaptureEntryGreeksInput;
    if (mode === 'chain') {
      payload = { source: 'chain' };
    } else {
      payload = {
        source: 'black_scholes',
        volatility: Number(volatility),
        spot: Number(spot),
        rate: Number(rate),
      };
      if (dividendYield) payload.dividendYield = Number(dividendYield);
    }

    try {
      await captureEntryGreeks.mutateAsync(payload);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to capture Greeks'));
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Entry Greeks — {position.symbol}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'black_scholes' | 'chain')}>
              <TabsList>
                {/* Radix activates a tab on mousedown/focus/keyboard, which a
                    plain `click` in jsdom never dispatches — the explicit
                    onClick keeps mouse-only test interaction in sync with
                    `mode`. */}
                <TabsTrigger
                  value="black_scholes"
                  className="cursor-pointer"
                  onClick={() => setMode('black_scholes')}
                >
                  Black-Scholes
                </TabsTrigger>
                {keyConfigured && (
                  <TabsTrigger
                    value="chain"
                    className="cursor-pointer"
                    onClick={() => setMode('chain')}
                  >
                    Chain
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>

            {mode === 'black_scholes' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="greeks-volatility">Volatility</Label>
                  <Input
                    id="greeks-volatility"
                    value={volatility}
                    onChange={(e) => setVolatility(e.target.value)}
                    placeholder="0.25"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="greeks-spot">Spot</Label>
                  <Input
                    id="greeks-spot"
                    value={spot}
                    onChange={(e) => setSpot(e.target.value)}
                    placeholder="150.00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="greeks-rate">Rate</Label>
                  <Input
                    id="greeks-rate"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="0.05"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="greeks-dividend-yield">Dividend yield</Label>
                  <Input
                    id="greeks-dividend-yield"
                    value={dividendYield}
                    onChange={(e) => setDividendYield(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={captureEntryGreeks.isPending}
            >
              {captureEntryGreeks.isPending ? 'Capturing...' : 'Capture'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
