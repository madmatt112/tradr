// OptionsChainViewer — the live options-chain card on the options-tools page
// (design §Component 12; REQ-12.1/12.2/12.3). ADDITIVE third card: it does NOT
// restructure the page and does not touch the Black-Scholes / OCC cards.
//
// States:
//   - No Unusual Whales key (`{ configured: false }`) → empty-state CTA to
//     Settings (REQ-12.2), NOT an error.
//   - Loading / rate-limited / unavailable / symbol-not-found → distinct UI
//     states driven by the REQ-6.5 reason code on the thrown error (REQ-12.3).
//   - Success → a compact strike/greeks table.

import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useOptionsChain, type OptionContract } from '../hooks/useOptionsChain';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

/** Map a thrown API error envelope to its REQ-6.5 reason code, if any. */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const e = err as { error?: { code?: string }; code?: string };
    return e.error?.code ?? e.code;
  }
  return undefined;
}

function num(value: number | undefined): string {
  return value === undefined || value === null ? '—' : String(value);
}

interface OptionsChainViewerProps {
  /**
   * Optional selection hook. When provided, each contract row with a non-empty
   * `option_symbol` renders a "Use" button that calls this with the row. When
   * omitted, the chain renders display-only (unchanged prop-less mount).
   */
  onSelectContract?: (contract: OptionContract) => void;
}

export function OptionsChainViewer({ onSelectContract }: OptionsChainViewerProps = {}) {
  const [symbolInput, setSymbolInput] = useState('');
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const debounced = useDebouncedValue(symbolInput.trim().toUpperCase(), 400);

  const query = useOptionsChain(debounced, expiry);

  // A chain is one expiry's ladder, so a held-over expiry from the previous
  // symbol would ask for a date the new ticker may not list. Clearing on symbol
  // change falls back to "nearest", which every ticker has.
  const onSymbolChange = (value: string) => {
    setSymbolInput(value);
    setExpiry(undefined);
  };

  // Defaulted rather than assumed: during a rolling deploy the web bundle and
  // the API can briefly disagree about the response shape, and a missing list
  // should hide the picker, not blank the whole viewer.
  const data = query.data;
  const expirations = data?.configured === true ? (data.expirations ?? []) : [];
  const selectedExpiry = data?.configured === true ? data.expiration : undefined;

  return (
    <Card data-slot="options-chain-viewer">
      <CardHeader>
        <CardTitle className="text-base">Options Chain</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="options-chain-symbol">Symbol</Label>
          <Input
            id="options-chain-symbol"
            type="text"
            autoComplete="off"
            placeholder="AAPL"
            value={symbolInput}
            onChange={(e) => onSymbolChange(e.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            Enter a US ticker to view its live options chain from Unusual Whales.
          </p>
        </div>

        {expirations.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="options-chain-expiry">Expiration</Label>
            <select
              id="options-chain-expiry"
              className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm cursor-pointer"
              value={selectedExpiry ?? ''}
              onChange={(e) => setExpiry(e.target.value)}
            >
              {expirations.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <ChainBody symbol={debounced} query={query} onSelectContract={onSelectContract} />
      </CardContent>
    </Card>
  );
}

function ChainBody({
  symbol,
  query,
  onSelectContract,
}: {
  symbol: string;
  query: ReturnType<typeof useOptionsChain>;
  onSelectContract?: (contract: OptionContract) => void;
}) {
  if (symbol === '') {
    return null;
  }

  if (query.isLoading) {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Loading chain…
      </p>
    );
  }

  if (query.isError) {
    return <ChainError code={errorCodeOf(query.error)} />;
  }

  const data = query.data;
  if (!data) return null;

  // No key configured → empty-state CTA to Settings (REQ-12.2).
  if (data.configured === false) {
    return <NoKeyState />;
  }

  const { chain } = data;
  if (chain.count === 0) {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        No contracts found for {chain.symbol}.
      </p>
    );
  }

  return <ChainTable contracts={chain.contracts} onSelectContract={onSelectContract} />;
}

function NoKeyState() {
  return (
    <div className="space-y-3 rounded-md border border-dashed p-4 text-center">
      <p className="text-sm text-muted-foreground">
        Connect an Unusual Whales key to view live options chains.
      </p>
      <Button asChild variant="outline" size="sm" className="cursor-pointer">
        <Link to="/settings/advisor">Go to Settings</Link>
      </Button>
    </div>
  );
}

function ChainError({ code }: { code?: string }) {
  const message = (() => {
    switch (code) {
      case 'MARKET_DATA_RATE_LIMITED':
      case 'PLATFORM_RATE_LIMITED':
        return 'Rate limited by Unusual Whales. Try again shortly.';
      case 'SYMBOL_NOT_FOUND':
        return 'No options chain found for that symbol.';
      case 'MARKET_DATA_KEY_INVALID':
        return 'Your Unusual Whales key was rejected. Update it in Settings.';
      default:
        return 'Unusual Whales is temporarily unavailable. Try again shortly.';
    }
  })();

  return (
    <p className="text-sm text-destructive" aria-live="polite" data-error-code={code}>
      {message}
    </p>
  );
}

function ChainTable({
  contracts,
  onSelectContract,
}: {
  contracts: OptionContract[];
  onSelectContract?: (contract: OptionContract) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Strike</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead>Bid</TableHead>
            <TableHead>Ask</TableHead>
            {/* The premium the "Use" button hands to the calculator: the last
                traded price, or the NBBO mid when the contract has not traded. */}
            <TableHead>Premium</TableHead>
            <TableHead>Vol</TableHead>
            <TableHead>OI</TableHead>
            {onSelectContract ? (
              <TableHead>
                <span className="sr-only">Select</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {contracts.map((row, i) => (
            <TableRow key={row.option_symbol ?? i}>
              <TableCell>{row.option_type ?? '—'}</TableCell>
              <TableCell>{num(row.strike)}</TableCell>
              <TableCell>{row.expiry ?? '—'}</TableCell>
              <TableCell>{num(row.bid)}</TableCell>
              <TableCell>{num(row.ask)}</TableCell>
              <TableCell>{num(row.premium)}</TableCell>
              <TableCell>{num(row.volume)}</TableCell>
              <TableCell>{num(row.open_interest)}</TableCell>
              {onSelectContract ? (
                <TableCell>
                  {row.option_symbol ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="cursor-pointer"
                      onClick={() => onSelectContract(row)}
                    >
                      Use
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
