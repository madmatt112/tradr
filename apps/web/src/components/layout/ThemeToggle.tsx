import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppTheme } from '@/hooks/useAppTheme';

type ThemeValue = 'light' | 'dark' | 'system';

const DEBOUNCE_MS = 300;

const OPTIONS: Array<{ value: ThemeValue; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

export function ThemeToggle() {
  const { theme, effectiveTheme, setTheme: persistTheme } = useAppTheme();
  // §D-r4: immediate visual flip uses next-themes directly; the network PUT
  // (via useAppTheme.setTheme) is debounced by 300ms.
  const nextTheme = useTheme();
  const latestRef = useRef<ThemeValue | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [announce, setAnnounce] = useState<string>('');

  useEffect(() => {
    return () => {
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Announce the effective theme whenever it changes.
  useEffect(() => {
    setAnnounce(`Theme: ${effectiveTheme}`);
  }, [effectiveTheme]);

  const handleSelect = useCallback(
    (t: ThemeValue) => {
      // Immediate visual change — no debouncing here.
      nextTheme.setTheme(t);
      latestRef.current = t;
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        const latest = latestRef.current;
        if (latest != null) {
          // useAppTheme.setTheme re-invokes next-themes (idempotent) and triggers
          // the network PUT + cross-tab broadcast.
          void persistTheme(latest);
        }
        timeoutRef.current = null;
      }, DEBOUNCE_MS);
    },
    [nextTheme, persistTheme],
  );

  const CurrentIcon =
    OPTIONS.find((o) => o.value === theme)?.Icon ?? OPTIONS.find((o) => o.value === 'system')!.Icon;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer"
            aria-label="Toggle theme"
          >
            <CurrentIcon className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuItem
              key={value}
              onSelect={() => handleSelect(value)}
              className="cursor-pointer"
              aria-checked={theme === value}
              role="menuitemradio"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </>
  );
}
