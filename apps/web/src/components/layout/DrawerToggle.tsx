import { PanelRightOpen } from 'lucide-react';
import { useContext } from 'react';

import { DrawerToggleRefContext } from '@/components/layout/DrawerToggleRefContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

// The drawer's opener. It used to sit alone in a 48px top bar that existed
// for nothing else — the bar is gone (visual-redesign task 4) and the control
// now sits inline at the end of every PageHeader strip, which is the slot
// that bar was standing in for. Deep-link pages without a PageHeader carry no
// opener; the drawer itself stays mounted app-wide, so one opened elsewhere
// still works there.
export function DrawerToggle() {
  const isOpen = useDrawerStore((s) => s.isOpen);
  const open = useDrawerStore((s) => s.open);
  const refCtx = useContext(DrawerToggleRefContext);

  return (
    <div
      data-testid="drawer-toggle"
      aria-hidden={isOpen}
      className={cn(
        'transition-opacity duration-200 ease-out motion-reduce:duration-0',
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
