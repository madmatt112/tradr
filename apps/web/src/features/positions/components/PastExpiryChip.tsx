// Past-expiry mark (design C10, Req 1.5/1.3): a leg past its expiry instant
// with no settlement recorded. The `warning` status role, never `gain`/
// `loss` or brand amber — and the text itself carries the signal, so colour
// is never the only channel (design System Status roles).
export function PastExpiryChip({ count }: { count?: number } = {}) {
  return (
    <span className="inline-flex items-center rounded-full border border-warning/50 px-2 py-px font-mono text-xs tracking-[0.06em] text-warning">
      Past expiry{count !== undefined && ` (${count})`}
    </span>
  );
}
