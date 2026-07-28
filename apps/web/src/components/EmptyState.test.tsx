// @vitest-environment node
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the title as an <h3> element', () => {
    const html = renderToStaticMarkup(<EmptyState title="No data" />);
    expect(html).toContain('No data');
    expect(html).toMatch(/<h3[^>]*>[^<]*No data[^<]*<\/h3>/);
  });

  it('renders description with muted-foreground styling when provided', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="Empty" description="Try adjusting filters" />,
    );
    expect(html).toContain('Try adjusting filters');
    // description is wrapped in a tag carrying the muted class
    expect(html).toMatch(/text-muted-foreground[^"]*"[^>]*>[^<]*Try adjusting filters/);
  });

  it('omits the description wrapper when description is not provided', () => {
    const html = renderToStaticMarkup(<EmptyState title="Empty" />);
    expect(html).not.toContain('Try adjusting filters');
  });

  it('uses a centered Card-like container for layout', () => {
    const html = renderToStaticMarkup(<EmptyState title="Empty" />);
    // Card component renders a div; EmptyState centers via flex + items-center + text-center
    expect(html).toMatch(/items-center/);
    expect(html).toMatch(/text-center/);
  });

  it('forwards icon and action ReactNodes unchanged', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="Empty"
        icon={<svg data-testid="icon" />}
        action={<button type="button">Retry</button>}
      />,
    );
    expect(html).toContain('data-testid="icon"');
    expect(html).toContain('Retry');
  });

  it('omits icon and action wrappers when not provided', () => {
    const html = renderToStaticMarkup(<EmptyState title="Empty" />);
    expect(html).not.toContain('data-testid="icon"');
    expect(html).not.toContain('Retry');
  });

  it('uses an on-ladder py-8 vertical padding (no off-ladder py-10)', () => {
    const html = renderToStaticMarkup(<EmptyState title="Empty" />);
    expect(html).toContain('py-8');
    expect(html).not.toContain('py-10');
  });
});

describe('EmptyState.Table', () => {
  // Render inside a real table so the colSpan cell is valid markup.
  function renderInTable(node: ReactNode) {
    return renderToStaticMarkup(
      <table>
        <tbody>{node}</tbody>
      </table>,
    );
  }

  it('renders a single row whose cell spans all columns (preserves column geometry)', () => {
    const html = renderInTable(<EmptyState.Table colSpan={8} message="No data" />);
    expect(html).toContain('data-testid="table-empty-state"');
    expect(html).toContain('colSpan="8"');
    expect(html).toContain('No data');
  });

  it('renders the message as a ReactNode', () => {
    const html = renderInTable(
      <EmptyState.Table colSpan={3} message={<span data-testid="custom-msg">Boom</span>} />,
    );
    expect(html).toContain('data-testid="custom-msg"');
    expect(html).toContain('Boom');
  });
});
