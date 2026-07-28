// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { useContext, useEffect, type MutableRefObject } from 'react';
import { describe, expect, it } from 'vitest';

import { DrawerToggleRefContext, DrawerToggleRefProvider } from './DrawerToggleRefContext';

describe('DrawerToggleRefContext', () => {
  it('provides the same ref instance across rerenders to a single consumer', () => {
    let refSeen1: MutableRefObject<HTMLButtonElement | null> | null = null;
    let refSeen2: MutableRefObject<HTMLButtonElement | null> | null = null;
    let captureIndex = 0;

    function Consumer() {
      const ref = useContext(DrawerToggleRefContext);
      useEffect(() => {
        if (captureIndex === 0) {
          refSeen1 = ref;
        } else {
          refSeen2 = ref;
        }
        captureIndex += 1;
      });
      return null;
    }

    const { rerender } = render(
      <DrawerToggleRefProvider>
        <Consumer />
      </DrawerToggleRefProvider>,
    );
    rerender(
      <DrawerToggleRefProvider>
        <Consumer />
      </DrawerToggleRefProvider>,
    );

    expect(refSeen1).not.toBeNull();
    expect(refSeen2).not.toBeNull();
    expect(Object.is(refSeen1, refSeen2)).toBe(true);
  });

  it('gives sibling consumers the same ref identity', () => {
    let ref1: MutableRefObject<HTMLButtonElement | null> | null = null;
    let ref2: MutableRefObject<HTMLButtonElement | null> | null = null;

    function ConsumerA() {
      const ref = useContext(DrawerToggleRefContext);
      useEffect(() => {
        ref1 = ref;
      });
      return null;
    }

    function ConsumerB() {
      const ref = useContext(DrawerToggleRefContext);
      useEffect(() => {
        ref2 = ref;
      });
      return null;
    }

    render(
      <DrawerToggleRefProvider>
        <ConsumerA />
        <ConsumerB />
      </DrawerToggleRefProvider>,
    );

    expect(ref1).not.toBeNull();
    expect(ref2).not.toBeNull();
    expect(ref1 === ref2).toBe(true);
  });
});
