import { PanelRightOpen } from 'lucide-react';
import { useContext } from 'react';

import { DrawerToggleRefContext } from '@/components/layout/DrawerToggleRefContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

export function DrawerToggle() {
  const isOpen = useDrawerStore((s) => s.isOpen);
  const open = useDrawerStore((s) => s.open);
  const refCtx = useContext(DrawerToggleRefContext);

  return (
    <div
      data-testid="drawer-topbar"
      aria-hidden={isOpen}
      className={cn(
        'flex justify-end border-b items-center px-4 transition-[height] duration-200 ease-out motion-reduce:duration-0 overflow-hidden',
        isOpen ? 'h-0 border-b-0' : 'h-12',
      )}
    >
      {!isOpen && (
        <Button
          ref={(el) => {
            if (refCtx) refCtx.current = el;
          }}
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer"
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
