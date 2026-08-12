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

import { Numeric } from '@/components/Numeric';
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
import {
  buildChainWindow,
  DEFAULT_STRIKE_RADIUS,
  isInTheMoney,
  sideForDirection,
  type ChainSide,
} from '../lib/chain-view';

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

interface OptionsChainViewerProps {
  /**
   * Optional selection hook. When provided, each contract row with a non-empty
   * `option_symbol` renders a "Use" button that calls this with the row. When
   * omitted, the chain renders display-only (unchanged prop-less mount).
   */
  onSelectContract?: (contract: OptionContract) => void;
  /**
   * The trade direction already chosen upstream in the sizing widget. It picks
   * which side of the chain opens — bullish shops calls, bearish shops puts —
   * so the picker does not ask a question the user has answered.
   */
  direction?: string;
}

export function OptionsChainViewer({ onSelectContract, direction }: OptionsChainViewerProps = {}) {
  const [symbolInput, setSymbolInput] = useState('');
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const [side, setSide] = useState<ChainSide>(() => sideForDirection(direction));
  const [radius, setRadius] = useState(DEFAULT_STRIKE_RADIUS);
  const debounced = useDebouncedValue(symbolInput.trim().toUpperCase(), 400);

  const query = useOptionsChain(debounced, expiry);

  // A chain is one expiry's ladder, so a held-over expiry from the previous
  // symbol would ask for a date the new ticker may not list. Clearing on symbol
  // change falls back to "nearest", which every ticker has. The widened strike
  // range resets too — it was widened to find something on the OLD ladder.
  const onSymbolChange = (value: string) => {
    setSymbolInput(value);
    setExpiry(undefined);
    setRadius(DEFAULT_STRIKE_RADIUS);
  };

  // Defaulted rather than assumed: during a rolling deploy the web bundle and
  // the API can briefly disagree about the response shape, and a missing list
  // should hide the picker, not blank the whole viewer.
  const data = query.data;
  const configured = data?.configured === true ? data : undefined;
  const expirations = configured?.expirations ?? [];
  const selectedExpiry = configured?.expiration;
  const spot = configured?.underlying?.price;

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
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-40 flex-1 space-y-2">
              <Label htmlFor="options-chain-expiry">Expiration</Label>
              <select
                id="options-chain-expiry"
                className="border-input bg-background h-9 w-full rounded-md border px-3 py-1 text-sm cursor-pointer"
                value={selectedExpiry ?? ''}
                onChange={(e) => {
                  setExpiry(e.target.value);
                  setRadius(DEFAULT_STRIKE_RADIUS);
                }}
              >
                {expirations.map((date) => (
                  <option key={date} value={date}>
                    {date}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label id="options-chain-side-label">Side</Label>
              <div
                role="group"
                aria-labelledby="options-chain-side-label"
                className="flex h-9 overflow-hidden rounded-md border"
              >
                {/* Labels are real text, not a CSS `capitalize` of the value:
                    the accessible name comes from the DOM, so styling it would
                    leave screen readers announcing "calls". */}
                {SIDE_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={side === value}
                    onClick={() => setSide(value)}
                    className={`cursor-pointer px-4 text-sm ${
                      side === value ? 'bg-primary text-primary-foreground' : 'bg-background'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <ChainBody
          symbol={debounced}
          query={query}
          side={side}
          spot={spot}
          radius={radius}
          onWiden={() => setRadius((r) => r + WIDEN_STEP)}
          onSelectContract={onSelectContract}
        />
      </CardContent>
    </Card>
  );
}

/** How many extra strikes each side "show more" reveals. */
const WIDEN_STEP = 20;

const SIDE_OPTIONS = [
  { value: 'call', label: 'Calls' },
  { value: 'put', label: 'Puts' },
] as const satisfies readonly { value: ChainSide; label: string }[];

function ChainBody({
  symbol,
  query,
  side,
  spot,
  radius,
  onWiden,
  onSelectContract,
}: {
  symbol: string;
  query: ReturnType<typeof useOptionsChain>;
  side: ChainSide;
  spot?: number;
  radius: number;
  onWiden: () => void;
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

  const view = buildChainWindow(chain.contracts, side, spot, radius);
  if (view.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        No {side}s on this expiration for {chain.symbol}.
      </p>
    );
  }

  const hidden = view.hiddenBelow + view.hiddenAbove;

  return (
    <div className="space-y-3">
      <UnderlyingBanner symbol={chain.symbol} underlying={data.underlying} />
      <ChainTable
        rows={view.rows}
        side={side}
        spot={spot}
        atmStrike={view.atmStrike}
        onSelectContract={onSelectContract}
      />
      {hidden > 0 ? (
        <div className="text-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={onWiden}
          >
            Show more strikes ({hidden} hidden)
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The underlying's last trade. Brokers put spot at the top of the chain because
 * every strike is read relative to it. `market_time` is surfaced rather than
 * hidden: a `postmarket` or `premarket` print is a stale reference, and a user
 * sizing a position off it should know that.
 */
function UnderlyingBanner({
  symbol,
  underlying,
}: {
  symbol: string;
  underlying?: { price?: number; market_time?: string; tape_time?: string };
}) {
  if (underlying?.price === undefined) return null;
  const session = underlying.market_time;
  const stale = session !== undefined && session !== 'regular';

  return (
    <p className="text-sm" data-slot="underlying-spot">
      <span className="font-medium">{symbol}</span>{' '}
      <Numeric value={underlying.price} direction="none" precision={2} />
      {stale ? (
        <span className="text-muted-foreground">
          {' '}
          · {session.replace(/^\w/, (c) => c.toUpperCase())}
        </span>
      ) : null}
    </p>
  );
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

/**
 * One side of the ladder, ascending by strike.
 *
 * Type and Expiry columns are gone: the side is chosen by the toggle and the
 * expiry by the picker, so both were constant down every row — pure noise in a
 * table that has to stay narrow enough to scan. In-the-money rows are shaded
 * and the at-the-money row is marked, which is how a broker chain tells you
 * where you are without reading a single number.
 */
function ChainTable({
  rows,
  side,
  spot,
  atmStrike,
  onSelectContract,
}: {
  rows: OptionContract[];
  side: ChainSide;
  spot?: number;
  atmStrike?: number;
  onSelectContract?: (contract: OptionContract) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Strike</TableHead>
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
          {rows.map((row, i) => {
            const itm = isInTheMoney(row, side, spot);
            const atm = atmStrike !== undefined && row.strike === atmStrike;
            return (
              <TableRow
                key={row.option_symbol ?? i}
                data-itm={itm ? 'true' : undefined}
                data-atm={atm ? 'true' : undefined}
                className={itm ? 'bg-muted/50' : undefined}
              >
                {/* Every figure goes through `Numeric` — the DOM enforcement
                    point for financial values. `direction="none"` because a
                    strike or a premium has no gain/loss sense; the signed,
                    coloured treatment belongs to P&L, not to a price. */}
                <TableCell className="font-medium">
                  <Numeric value={row.strike ?? null} direction="none" precision={2} />
                  {atm ? (
                    <span className="text-muted-foreground ml-2 text-xs font-normal">ATM</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Numeric value={row.bid ?? null} direction="none" precision={2} />
                </TableCell>
                <TableCell>
                  <Numeric value={row.ask ?? null} direction="none" precision={2} />
                </TableCell>
                <TableCell>
                  <Numeric value={row.premium ?? null} direction="none" precision={2} />
                </TableCell>
                <TableCell>
                  <Numeric value={row.volume ?? null} kind="integer" direction="none" />
                </TableCell>
                <TableCell>
                  <Numeric value={row.open_interest ?? null} kind="integer" direction="none" />
                </TableCell>
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
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
