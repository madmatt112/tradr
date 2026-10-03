import { Menu } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';

import { SidebarNav, SidebarSession } from '@/components/layout/Sidebar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useDrawerStore } from '@/stores/drawer.store';

// MobileNav (design C5, Requirement 5): below 768 px the desk rail is hidden
// (task 9) and this sticky header is the only route to every destination. The
// menu button opens a modal Radix dialog — a left-edge drawer composed from the
// very SidebarNav / SidebarSession the rail uses, so the two can never drift.
//
// The overlay and the side (position) drawer are mutually exclusive: opening
// one closes the other. Widening past 768 px closes the overlay too, since the
// rail takes over there (Requirement 5.4).
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const drawerOpen = useDrawerStore((s) => s.isOpen);
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // Opening the overlay closes the side drawer (Requirement 5.4).
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) useDrawerStore.getState().close();
  }

  // The side drawer opening closes the overlay (Requirement 5.4).
  useEffect(() => {
    if (drawerOpen) setOpen(false);
  }, [drawerOpen]);

  // A viewport at or above the breakpoint hands navigation back to the rail, so
  // the overlay closes (Requirement 5.4).
  useEffect(() => {
    if (isDesktop) setOpen(false);
  }, [isDesktop]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <header className="md:hidden sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-hairline bg-card px-4">
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="cursor-pointer text-muted-foreground"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <span className="flex items-baseline gap-1.5 text-base font-bold">
          <span aria-hidden="true" className="text-xs text-primary">
            ▴
          </span>
          Tradr
        </span>
      </header>

      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-hairline bg-card"
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <SidebarNav expanded onNavigate={() => setOpen(false)} />
          <SidebarSession expanded />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
