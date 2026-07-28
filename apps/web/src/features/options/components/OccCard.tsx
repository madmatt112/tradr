import { useEffect, useState } from 'react';

import { encodeOccSymbol, parseOccSymbol } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ---------------------------------------------------------------------------
// Debounce hook (v1-10 contract: 300ms on free-text only)
// ---------------------------------------------------------------------------

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = 'decode' | 'encode';

export function OccCard() {
  // Active mode is local state — NOT serialised to the URL (REQ-7.4).
  const [mode, setMode] = useState<Mode>('decode');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">OCC Symbol Decoder / Encoder</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList>
            <TabsTrigger value="decode" className="cursor-pointer">
              Decode
            </TabsTrigger>
            <TabsTrigger value="encode" className="cursor-pointer">
              Encode
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'decode' ? <DecodeMode /> : <EncodeMode />}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Decode mode (300ms debounce on free-text — REQ-7.7)
// ---------------------------------------------------------------------------

function DecodeMode() {
  const [raw, setRaw] = useState('');
  const debouncedRaw = useDebouncedValue(raw, 300);

  // Empty input → no result block.
  if (debouncedRaw.trim() === '') {
    return (
      <div className="space-y-2">
        <Label htmlFor="occ-decode-input">OCC symbol</Label>
        <Input
          id="occ-decode-input"
          type="text"
          autoComplete="off"
          placeholder="AAPL  250620C00150000"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          Enter an OCC option symbol to decode it into underlying, expiration, type, and strike.
        </p>
      </div>
    );
  }

  const parsed = parseOccSymbol(debouncedRaw);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="occ-decode-input">OCC symbol</Label>
        <Input
          id="occ-decode-input"
          type="text"
          autoComplete="off"
          placeholder="AAPL  250620C00150000"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
      </div>

      {parsed.ok ? (
        <div className="space-y-2" aria-live="polite">
          <ResultRow label="Underlying" value={parsed.value.underlying} />
          <ResultRow label="Expiration" value={parsed.value.expiration} />
          <ResultRow label="Type" value={parsed.value.type} />
          <ResultRow label="Strike" value={parsed.value.strike} />
          <CopyButton text={canonicalFromParsed(parsed.value, debouncedRaw)} />
        </div>
      ) : (
        <p className="text-sm text-destructive" aria-live="polite">
          {parsed.error.message}
        </p>
      )}
    </div>
  );
}

// v1-11 Copy defence: prefer canonical encode; fall back to raw .trim().toUpperCase().
function canonicalFromParsed(
  parsedValue: { underlying: string; expiration: string; type: 'call' | 'put'; strike: string },
  raw: string,
): string {
  const re = encodeOccSymbol(parsedValue);
  if (re.ok) return re.value;
  return raw.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Encode mode (no debounce on discrete inputs — REQ-7.7)
// ---------------------------------------------------------------------------

function EncodeMode() {
  const [underlying, setUnderlying] = useState('');
  const [expiration, setExpiration] = useState('');
  const [type, setType] = useState<'call' | 'put'>('call');
  const [strike, setStrike] = useState('');

  const allFilled = underlying.trim() !== '' && expiration.trim() !== '' && strike.trim() !== '';

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="occ-encode-underlying">Underlying</Label>
        <Input
          id="occ-encode-underlying"
          type="text"
          autoComplete="off"
          placeholder="AAPL"
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="occ-encode-expiration">Expiration</Label>
        <Input
          id="occ-encode-expiration"
          type="date"
          value={expiration}
          onChange={(e) => setExpiration(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>Type</Label>
        <Tabs value={type} onValueChange={(v) => setType(v as 'call' | 'put')}>
          <TabsList>
            <TabsTrigger value="call" className="cursor-pointer">
              Call
            </TabsTrigger>
            <TabsTrigger value="put" className="cursor-pointer">
              Put
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="space-y-2">
        <Label htmlFor="occ-encode-strike">Strike</Label>
        <Input
          id="occ-encode-strike"
          type="text"
          inputMode="decimal"
          placeholder="150.00"
          value={strike}
          onChange={(e) => setStrike(e.target.value)}
        />
      </div>

      {allFilled && (
        <EncodeResult underlying={underlying} expiration={expiration} type={type} strike={strike} />
      )}
    </div>
  );
}

function EncodeResult({
  underlying,
  expiration,
  type,
  strike,
}: {
  underlying: string;
  expiration: string;
  type: 'call' | 'put';
  strike: string;
}) {
  // Live call on every render (changes propagate immediately — no debounce).
  const result = encodeOccSymbol({
    underlying: underlying.toUpperCase(),
    expiration,
    type,
    strike,
  });

  if (result.ok) {
    return (
      <div className="space-y-2" aria-live="polite">
        <ResultRow label="OCC symbol" value={result.value} mono />
        <CopyButton text={result.value} />
      </div>
    );
  }
  return (
    <p className="text-sm text-destructive" aria-live="polite">
      {result.error.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ResultRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono font-medium' : 'font-medium'}>{value}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silent no-op.
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="cursor-pointer"
      onClick={handleCopy}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
