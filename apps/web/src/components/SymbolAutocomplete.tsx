// SymbolAutocomplete — reusable ticker combobox (design §SymbolAutocomplete;
// REQ-7.1–7.6). Self-contained and prop-driven so it is usable outside the
// calculator unmodified. Debounces input (250 ms), uppercases the query for
// matching, drives useSymbolSearch, and renders results in a Popover anchored to
// the Input. The Popover portals to document.body so the dropdown is not clipped
// inside the dashboard widget grid cell (REQ-7.6). Keyboard navigation is
// hand-rolled over aria-activedescendant. Distinct loading / empty / error
// states; on a search-endpoint error it degrades to a plain text input the user
// can still type into (REQ-7.3). No new heavy dependency — built on the existing
// Input + the already-installed radix-ui Popover (REQ-7.5).

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSymbolSearch } from '@/hooks/useSymbolSearch';
import { cn } from '@/lib/utils';

export interface SymbolAutocompleteProps {
  value: string;
  /** Fires on selection (or commit) with the uppercased ticker. */
  onChange: (ticker: string) => void;
  /** Optional: raw typed text on every keystroke. */
  onQueryChange?: (raw: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}

export function SymbolAutocomplete({
  value,
  onChange,
  onQueryChange,
  placeholder,
  id,
  disabled,
}: SymbolAutocompleteProps) {
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  // The text shown in the input. Seeded from `value` and re-synced whenever the
  // parent changes `value` externally (e.g. a mode-switch clear). The parent
  // only updates `value` on commit, so this does not clobber in-progress typing.
  const [query, setQuery] = React.useState(value);
  React.useEffect(() => {
    setQuery(value);
  }, [value]);

  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const debouncedQuery = useDebouncedValue(query.trim().toUpperCase(), 250);
  const { data, isLoading, isError } = useSymbolSearch(debouncedQuery);
  const results = data?.results ?? [];
  const hasQuery = debouncedQuery.length >= 1;

  // A fresh query invalidates the current highlight and any prior dismissal.
  React.useEffect(() => {
    setActiveIndex(-1);
    setDismissed(false);
  }, [debouncedQuery]);

  // On endpoint error, degrade to a plain text input: no dropdown (REQ-7.3).
  const degraded = isError;
  const open = Boolean(focused && !dismissed && !degraded && hasQuery && !disabled);

  const commit = (ticker: string) => {
    const upper = ticker.trim().toUpperCase();
    if (!upper) return;
    setQuery(upper);
    onChange(upper);
    setDismissed(true);
    setActiveIndex(-1);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setQuery(raw);
    onQueryChange?.(raw);
    setDismissed(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        if (results.length === 0) return;
        e.preventDefault();
        setDismissed(false);
        setActiveIndex((i) => (i + 1 >= results.length ? results.length - 1 : i + 1));
        break;
      case 'ArrowUp':
        if (results.length === 0) return;
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? 0 : i - 1));
        break;
      case 'Enter':
        if (open && activeIndex >= 0 && results[activeIndex]) {
          e.preventDefault();
          commit(results[activeIndex].ticker);
        } else if (query.trim().length > 0) {
          // Degraded / no-highlight path: commit the uppercased typed value.
          e.preventDefault();
          commit(query);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setDismissed(true);
          setActiveIndex(-1);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className="relative w-full" data-slot="symbol-autocomplete">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setDismissed(true);
            setActiveIndex(-1);
          }
        }}
      >
        <PopoverAnchor asChild>
          <Input
            id={id}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            value={query}
            placeholder={placeholder}
            disabled={disabled}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] max-h-64 overflow-y-auto p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {isLoading ? (
            <div
              data-slot="symbol-autocomplete-loading"
              className="px-3 py-2 text-sm text-muted-foreground"
            >
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div
              data-slot="symbol-autocomplete-empty"
              className="px-3 py-2 text-sm text-muted-foreground"
            >
              No matches
            </div>
          ) : (
            <ul role="listbox" id={listboxId} className="py-1">
              {results.map((r, i) => (
                <li
                  key={r.ticker}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  data-slot="symbol-option"
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm',
                    i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    // Keep focus in the input so selection is not lost to blur.
                    e.preventDefault();
                    commit(r.ticker);
                  }}
                >
                  <span className="font-medium">{r.ticker}</span>
                  <span className="truncate text-muted-foreground">{r.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{r.exchange}</span>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {degraded && (
        <p
          data-slot="symbol-autocomplete-error"
          role="alert"
          className="mt-1 text-sm text-destructive"
        >
          Symbol search is unavailable. You can still type a ticker manually.
        </p>
      )}
    </div>
  );
}
