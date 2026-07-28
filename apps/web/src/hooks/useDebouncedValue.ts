import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` that only updates after `delayMs` has
 * elapsed without further changes. Shared extraction of the debounce helper that
 * was privately duplicated inside the options feature (OptionsChainViewer /
 * OccCard); any `@/components` file must consume this shared hook rather than
 * reach into a feature's internals.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
