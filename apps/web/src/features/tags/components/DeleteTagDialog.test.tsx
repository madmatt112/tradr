// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TagWithCount } from '@tradr/shared';

import { DeleteTagDialog } from './DeleteTagDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tag(overrides: Partial<TagWithCount> = {}): TagWithCount {
  return {
    id: 't1',
    name: 'breakout',
    category: 'setup',
    color: null,
    positionCount: 4,
    ...overrides,
  };
}

function renderDialog(props: { tag: TagWithCount; ruleCount?: number }) {
  return render(
    <DeleteTagDialog
      open
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
      tag={props.tag}
      ruleCount={props.ruleCount}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('DeleteTagDialog scoped-rule copy', () => {
  it('names no rules when none are scoped to the tag', () => {
    renderDialog({ tag: tag({ positionCount: 4 }), ruleCount: 0 });

    expect(
      screen.getByText('Delete «breakout»? It will be removed from 4 positions.'),
    ).toBeTruthy();
    expect(screen.queryByText(/It also deletes/)).toBeNull();
  });

  it('names one scoped rule in the singular', () => {
    renderDialog({ tag: tag({ positionCount: 4 }), ruleCount: 1 });

    expect(
      screen.getByText(
        'Delete «breakout»? It will be removed from 4 positions. It also deletes 1 rule scoped to it.',
      ),
    ).toBeTruthy();
  });

  it('names several scoped rules in the plural', () => {
    renderDialog({ tag: tag({ positionCount: 4 }), ruleCount: 3 });

    expect(
      screen.getByText(
        'Delete «breakout»? It will be removed from 4 positions. It also deletes 3 rules scoped to it.',
      ),
    ).toBeTruthy();
  });
});
