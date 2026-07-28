import { createContext, useRef, type MutableRefObject, type ReactNode } from 'react';

export const DrawerToggleRefContext =
  createContext<MutableRefObject<HTMLButtonElement | null> | null>(null);

export function DrawerToggleRefProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return <DrawerToggleRefContext.Provider value={ref}>{children}</DrawerToggleRefContext.Provider>;
}
