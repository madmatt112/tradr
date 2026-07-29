// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { shouldNavigateFromRowClick } from './rowNavigation';

type ClickLike = Parameters<typeof shouldNavigateFromRowClick>[0];

/** Minimal stand-in for the React synthetic click the row handler receives. */
function clickOn(target: HTMLElement, overrides: Partial<ClickLike> = {}): ClickLike {
  // `currentTarget` defaults to an ancestor that contains the target, matching
  // a real bubble; the portal test overrides it with a detached row.
  const row = target.closest('tr') ?? target.parentElement ?? target;
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    currentTarget: row,
    ...overrides,
  } as ClickLike;
}

function cellWith(innerHtml: string): { cell: HTMLElement; child: HTMLElement } {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.innerHTML = innerHtml;
  row.appendChild(cell);
  return { cell, child: cell.firstElementChild as HTMLElement };
}

describe('shouldNavigateFromRowClick', () => {
  it('navigates on a plain primary click on inert row content', () => {
    const { child } = cellWith('<span>AAPL</span>');
    expect(shouldNavigateFromRowClick(clickOn(child))).toBe(true);
  });

  it('defers to the symbol link so a click is not handled twice', () => {
    const { child } = cellWith('<a href="/positions/1">AAPL</a>');
    expect(shouldNavigateFromRowClick(clickOn(child))).toBe(false);
  });

  it('defers to the actions menu trigger', () => {
    const { child } = cellWith('<button type="button">⋯</button>');
    expect(shouldNavigateFromRowClick(clickOn(child))).toBe(false);
  });

  // Regression: a disabled button emits no pointer events, so the click lands
  // on the tooltip's span wrapper — the button's PARENT — and closest('button')
  // finds nothing. Matching the action strip is what stops the fall-through.
  it('defers when the click lands on the wrapper around a disabled button', () => {
    const { cell } = cellWith(
      '<div data-slot="row-actions"><span id="wrap"><button type="button" disabled>x</button></span></div>',
    );
    const wrapper = cell.querySelector('#wrap') as HTMLElement;
    expect(shouldNavigateFromRowClick(clickOn(wrapper))).toBe(false);
  });

  it('defers on the gaps between action buttons', () => {
    const { cell } = cellWith('<div data-slot="row-actions" id="strip"></div>');
    const strip = cell.querySelector('#strip') as HTMLElement;
    expect(shouldNavigateFromRowClick(clickOn(strip))).toBe(false);
  });

  it('defers when the click lands on an element nested inside a button', () => {
    const { cell } = cellWith('<button type="button"><span id="glyph">⋯</span></button>');
    const glyph = cell.querySelector('#glyph') as HTMLElement;
    expect(shouldNavigateFromRowClick(clickOn(glyph))).toBe(false);
  });

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('leaves a %s-modified click to the browser (new tab/window)', (_label, mods) => {
    const { child } = cellWith('<span>AAPL</span>');
    expect(shouldNavigateFromRowClick(clickOn(child, mods))).toBe(false);
  });

  it('ignores non-primary buttons (middle-click opens a background tab)', () => {
    const { child } = cellWith('<span>AAPL</span>');
    expect(shouldNavigateFromRowClick(clickOn(child, { button: 1 }))).toBe(false);
  });

  it('ignores a click something else already handled', () => {
    const { child } = cellWith('<span>AAPL</span>');
    expect(shouldNavigateFromRowClick(clickOn(child, { defaultPrevented: true }))).toBe(false);
  });

  // Regression: the row's dialogs are portalled to document.body, but a React
  // portal keeps the React tree intact, so clicks inside them bubbled to the
  // row handler and navigated away from the open dialog.
  it('ignores clicks from portalled content outside the row subtree', () => {
    const row = document.createElement('tr');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<label>Quantity</label>';
    document.body.append(row, dialog);

    const label = dialog.querySelector('label') as HTMLElement;
    expect(shouldNavigateFromRowClick(clickOn(label, { currentTarget: row }))).toBe(false);

    row.remove();
    dialog.remove();
  });
});
