import { PanelRightClose } from 'lucide-react';
import { FocusScope as FocusScopePrimitive } from 'radix-ui/internal';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DrawerToggleRefContext } from '@/components/layout/DrawerToggleRefContext';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OpenPositionsTab } from '@/features/drawer/components/OpenPositionsTab';
import { OptionsPricingTab } from '@/features/drawer/components/OptionsPricingTab';
import { QuickStatsTab } from '@/features/drawer/components/QuickStatsTab';
import { RecentlyCreatedTab } from '@/features/drawer/components/RecentlyCreatedTab';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import {
  DRAWER_STORAGE_KEY,
  type DrawerTab,
  useDrawerStore,
  writeDrawerState,
} from '@/stores/drawer.store';

/**
 * Module-scoped flag used to suppress the store→localStorage write subscription
 * when a store mutation originated from a cross-tab `storage` event. Must be
 * module-scoped (NOT a `useRef`) per design v3-4 so StrictMode double-mounts
 * share the same flag instance.
 */
const fromStorageEvent = { current: false };

interface DrawerHeaderProps {
  activeTab: DrawerTab;
  setActiveTab: (tab: DrawerTab) => void;
  onClose: () => void;
}

function DrawerHeader({ activeTab, setActiveTab, onClose }: DrawerHeaderProps) {
  return (
    <div className="flex items-start gap-1 border-b p-2">
      {/* min-w-0 lets the tab strip shrink inside the fixed-width drawer; the
          TabsList wraps to a second row so all four full labels stay visible
          (the 360px drawer can't fit them on one line). */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DrawerTab)}
        className="min-w-0 flex-1"
      >
        {/* `!h-auto` overrides TabsList's default single-row `h-9` so the muted
            track grows to wrap both rows of the 2x2 grid. */}
        <TabsList className="grid !h-auto w-full grid-cols-2 gap-1">
          <TabsTrigger value="open-positions">Open Positions</TabsTrigger>
          <TabsTrigger value="quick-stats">Quick Stats</TabsTrigger>
          <TabsTrigger value="options-pricing">Options Pricing</TabsTrigger>
          <TabsTrigger value="recently-created">Recently Created</TabsTrigger>
        </TabsList>
      </Tabs>
      {/* shrink-0 pins the close control so the tabs can never push it
          off-screen. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 cursor-pointer"
        onClick={onClose}
        aria-label="Close side drawer"
      >
        <PanelRightClose className="h-4 w-4" />
      </Button>
    </div>
  );
}

interface DrawerBodyProps {
  activeTab: DrawerTab;
}

function DrawerBody({ activeTab }: DrawerBodyProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <Tabs value={activeTab}>
        <TabsContent value="open-positions">
          <OpenPositionsTab />
        </TabsContent>
        <TabsContent value="quick-stats">
          <QuickStatsTab />
        </TabsContent>
        {activeTab === 'options-pricing' && (
          <TabsContent value="options-pricing">
            <OptionsPricingTab />
          </TabsContent>
        )}
        <TabsContent value="recently-created">
          <RecentlyCreatedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function SideDrawer() {
  const isOpen = useDrawerStore((s) => s.isOpen);
  const activeTab = useDrawerStore((s) => s.activeTab);
  const setActiveTab = useDrawerStore((s) => s.setActiveTab);
  const close = useDrawerStore((s) => s.close);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const showBackdrop = useMediaQuery('(max-width: 1023px)');
  const [skipTransition, setSkipTransition] = useState(false);
  const [storageEventCount, setStorageEventCount] = useState(0);
  const toggleRefCtx = useContext(DrawerToggleRefContext);
  const drawerRef = useRef<HTMLElement | null>(null);
  const isMobileRef = useRef(isMobile);

  // Mirror `isMobile` into a ref so the mount-only Escape listener can read
  // the current value without resubscribing on every change.
  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  // EFFECT 1: cross-tab `storage` reconciliation.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== DRAWER_STORAGE_KEY) return;
      setStorageEventCount((c) => c + 1);
      if (e.newValue === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.newValue);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.version === 'number' && obj.version > 1) {
        useDrawerStore.setState({ legacyDetected: true });
        return;
      }
      if (typeof obj.isOpen === 'boolean') {
        setSkipTransition(true);
        fromStorageEvent.current = true;
        useDrawerStore.setState({ isOpen: obj.isOpen });
        fromStorageEvent.current = false;
        requestAnimationFrame(() => setSkipTransition(false));
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // EFFECT 2: store → localStorage write subscription.
  useEffect(() => {
    return useDrawerStore.subscribe((state, prev) => {
      if (fromStorageEvent.current) return;
      if (state.legacyDetected) return;
      if (state.isOpen === prev.isOpen && state.activeTab === prev.activeTab) {
        return;
      }
      writeDrawerState({ isOpen: state.isOpen, activeTab: state.activeTab });
    });
  }, []);

  // EFFECT 3: focus management on `isOpen` transitions.
  useEffect(() => {
    if (isOpen) {
      const activeTrigger = drawerRef.current?.querySelector<HTMLElement>(
        '[role="tab"][data-state="active"]',
      );
      activeTrigger?.focus();
    } else {
      // preventScroll: the toggle sits at the top of <main>; on mobile the body
      // scroll-lock has just restored the pre-open scroll offset (REQ v4-6), and
      // a scrolling .focus() here would yank the page back to the top, undoing
      // it.
      toggleRefCtx?.current?.focus({ preventScroll: true });
    }
  }, [isOpen, toggleRefCtx]);

  // EFFECT 5: iOS-safe body scroll lock while drawer is open on mobile.
  useEffect(() => {
    if (!(isMobile && isOpen)) return;
    const body = document.body;
    const savedPosition = body.style.position;
    const savedTop = body.style.top;
    const savedWidth = body.style.width;
    const savedScrollY = window.scrollY;
    body.style.position = 'fixed';
    body.style.top = `-${savedScrollY}px`;
    body.style.width = '100%';
    return () => {
      body.style.position = savedPosition;
      body.style.top = savedTop;
      body.style.width = savedWidth;
      window.scrollTo(0, savedScrollY);
    };
  }, [isMobile, isOpen]);

  // EFFECT 6: Escape closes on mobile only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!isMobileRef.current) return;
      useDrawerStore.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {showBackdrop && (
        <div
          data-testid="drawer-backdrop"
          aria-hidden
          onClick={close}
          className={cn(
            'fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 ease-out motion-reduce:duration-0',
            isOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
      )}
      <FocusScopePrimitive.Root
        loop
        trapped={isMobile && isOpen}
        onMountAutoFocus={(e) => e.preventDefault()}
      >
        <aside
          ref={drawerRef}
          id="side-drawer"
          role="region"
          aria-label="Side drawer"
          aria-hidden={!isOpen}
          data-testid="side-drawer"
          data-state={isOpen ? 'open' : 'closed'}
          data-skip-transition={skipTransition ? 'true' : 'false'}
          data-storage-event-count={storageEventCount}
          className={cn(
            'fixed inset-y-0 right-0 z-40 flex h-screen flex-col bg-background border-l shadow-xl w-full md:w-[360px] transition-transform duration-200 ease-out motion-reduce:duration-0',
            isOpen ? 'translate-x-0' : 'translate-x-full',
            skipTransition && '!transition-none',
          )}
        >
          <DrawerHeader activeTab={activeTab} setActiveTab={setActiveTab} onClose={close} />
          <DrawerBody activeTab={activeTab} />
        </aside>
      </FocusScopePrimitive.Root>
    </>,
    document.body,
  );
}

export default SideDrawer;
