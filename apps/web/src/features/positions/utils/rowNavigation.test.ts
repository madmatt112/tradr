// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { shouldNavigateFromRowClick } from './rowNavigation';

type ClickLike = Parameters<typeof shouldNavigateFromRowClick>[0];

/** Minimal stand-in for the React synthetic click the row handler receives. */
function clickOn(target: HTMLElement, overrides: Partial<ClickLike> = {}): ClickLike {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...overrides,
  } as ClickLike;
}

function cellWith(innerHtml: string): { cell: HTMLElement; child: HTMLElement } {
  const cell = document.createElement('td');
  cell.innerHTML = innerHtml;
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
});
