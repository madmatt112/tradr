import { PanelRightOpen } from 'lucide-react';
import { useContext } from 'react';

import { DrawerToggleRefContext } from '@/components/layout/DrawerToggleRefContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

// The drawer's opener, floating at the top-right of the viewport. It used to
// sit alone in a 48px top bar that existed for nothing else — the bar is gone
// (visual-redesign task 4) and the control now floats where the drawer slides
// in from, until the shared PageHeader (task 5) gives it a proper slot. Fixed
// positioning keeps it out of the document flow; z-20 sits under the drawer's
// overlay (z-30) so the open drawer covers it.
export function DrawerToggle() {
  const isOpen = useDrawerStore((s) => s.isOpen);
  const open = useDrawerStore((s) => s.open);
  const refCtx = useContext(DrawerToggleRefContext);

  return (
    <div
      data-testid="drawer-toggle"
      aria-hidden={isOpen}
      className={cn(
        'fixed right-3 top-3 z-20 transition-opacity duration-200 ease-out motion-reduce:duration-0',
        isOpen && 'pointer-events-none opacity-0',
      )}
    >
      {!isOpen && (
        <Button
          ref={(el) => {
            if (refCtx) refCtx.current = el;
          }}
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer text-muted-foreground"
          onClick={open}
          aria-label="Open side drawer"
          aria-expanded={false}
          aria-controls="side-drawer"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
