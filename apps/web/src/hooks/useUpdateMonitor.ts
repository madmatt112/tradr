import { useSyncExternalStore } from 'react';

import { getUpdateMonitor, type MonitorSnapshot } from '@/lib/updateMonitor';

/**
 * Subscribe the React tree to the app-wide update monitor. The monitor's
 * getSnapshot() is referentially stable until its state changes, so this
 * re-renders only on a real transition (useSyncExternalStore compares with
 * Object.is). Precedent: hooks/useMediaQuery.ts.
 */
export function useUpdateMonitor(): MonitorSnapshot {
  const monitor = getUpdateMonitor();
  return useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
}
