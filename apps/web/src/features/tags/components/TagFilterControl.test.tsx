// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TagWithCount } from '@tradr/shared';

import { TagFilterControl } from './TagFilterControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix menus need pointer-capture + scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const UNKNOWN = '00000000-0000-0000-0000-0000000000ff';

const TAGS: TagWithCount[] = [
  { id: A, name: 'breakout', category: 'setup', color: null, positionCount: 2 },
  { id: B, name: 'FOMO', category: 'emotion', color: null, positionCount: 1 },
];

/** Render inside a memory-history router so the "Manage tags in Settings" Link
 *  has router context. */
function renderInRouter(ui: React.ReactElement) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/',
    component: () => ui,
  });
  const settingsTags = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/settings/tags',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsTags]) as any,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router as any} />);
}

describe('TagFilterControl', () => {
  it('toggling two tags in reverse order reports both ids, unsorted', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();

    function Stateful() {
      const [ids, setIds] = useState<string[]>([]);
      return (
        <TagFilterControl
          tags={TAGS}
          selectedIds={ids}
          onChange={(next) => {
            onChange(next);
            setIds(next);
          }}
        />
      );
    }

    renderInRouter(<Stateful />);

    await user.click(await screen.findByRole('button', { name: /Tags/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'FOMO' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'breakout' }));

    // The control never sorts — insertion order B then A — the sort is
    // PositionList's job before it writes the URL.
    expect(onChange).toHaveBeenLastCalledWith([B, A]);
  });

  it('renders an Unknown tag chip for a selected id the user does not own and removes it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();

    renderInRouter(<TagFilterControl tags={TAGS} selectedIds={[UNKNOWN]} onChange={onChange} />);

    expect(await screen.findByLabelText('unknown: Unknown tag')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove unknown tag from filter' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('"Clear filter" reports the empty selection', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();

    renderInRouter(<TagFilterControl tags={TAGS} selectedIds={[A]} onChange={onChange} />);

    await user.click(await screen.findByRole('button', { name: /Tags/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Clear filter' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('with no tags shows the empty item and the Settings link', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderInRouter(<TagFilterControl tags={[]} selectedIds={[]} onChange={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Tags/ }));
    expect(screen.getByText('No tags yet')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Manage tags in Settings' })).toBeTruthy();
  });
});
