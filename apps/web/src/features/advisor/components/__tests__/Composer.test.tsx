// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TierState } from '@tradr/shared';
import type { Persona } from '@tradr/shared/schemas/advisor';

import { captureClientEvent } from '@/lib/telemetry/posthog';

import { Composer, type ComposerSubmit } from '../Composer';

// The billing-refusal banner renders router <Link>s on linked branches; mount
// without a RouterProvider by stubbing it. onClick must pass through (the
// upgrade CTA fires the D17 funnel event on click); preventDefault suppresses
// jsdom's not-implemented navigation.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    onClick,
    children,
  }: {
    to: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    children: React.ReactNode;
  }) => (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

// The upgrade CTA telemetry seam (plan-tiers D17).
vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks crypto.randomUUID in some setups and never implements
// URL.createObjectURL — stub both so the component runs.
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
  });
}
let blobCounter = 0;
URL.createObjectURL = vi.fn(() => `blob:preview-${blobCounter++}`);
URL.revokeObjectURL = vi.fn();

const PERSONAS: Persona[] = [
  {
    id: 'default-trading-advisor',
    userId: null,
    name: 'Trading Advisor',
    description: null,
    systemPrompt: 'x',
    isBuiltin: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'risk-coach',
    userId: null,
    name: 'Risk Coach',
    description: null,
    systemPrompt: 'x',
    isBuiltin: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// Tier-state builder (plan-tiers Component 12): gating on, Free tier at the
// REQ-5.1 cap numbers; per-test usage overrides drive headroom/hints.
function tierState(usage: { allowanceUsed?: number; imagesUsed?: number } = {}): TierState {
  return {
    gatingEnabled: true,
    exempt: false,
    tier: 'free',
    purchasable: true,
    subscription: null,
    limits: {
      free: {
        accounts: 2,
        positions: 500,
        lookbackMonths: 6,
        platformTurns: 25,
        images: 20,
        csvImports: 10,
      },
      pro: {
        accounts: null,
        positions: null,
        lookbackMonths: null,
        platformTurns: 200,
        images: 500,
        csvImports: null,
      },
    },
    usage: {
      accounts: { used: 1, writableAccountId: null },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: usage.allowanceUsed ?? 0 },
      images: { used: usage.imagesUsed ?? 0 },
      csvImports: { used: 0 },
    },
  };
}

let mounted: { container: HTMLElement; root: Root } | null = null;
function mount(ui: React.ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { container, root };
  act(() => root.render(ui));
}

function unmountCurrent(): void {
  if (!mounted) return;
  const current = mounted;
  act(() => current.root.unmount());
  current.container.remove();
  mounted = null;
}

/** Text of every link inside the billing-refusal banner, in DOM order. */
function bannerLinkLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="billing-refusal"] a')).map(
    (a) => a.textContent ?? '',
  );
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function getTextarea(): HTMLTextAreaElement {
  return document.querySelector('textarea[aria-label="Message"]')!;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222');
});

describe('Composer', () => {
  it('submits once on Enter with a clientMessageId, and Shift+Enter inserts a newline instead', () => {
    const onSubmit = vi.fn<(s: ComposerSubmit) => void>();
    mount(<Composer personas={PERSONAS} visionEnabled={false} onSubmit={onSubmit} />);

    const textarea = getTextarea();
    typeInto(textarea, 'hello advisor');

    // Shift+Enter must NOT submit (REQ-1.12 / restriction: no auto-submit on Shift+Enter).
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();

    // Plain Enter submits exactly once.
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0]![0];
    expect(submission.text).toBe('hello advisor');
    expect(submission.clientMessageId).toBe('22222222-2222-4222-8222-222222222222');
    expect(submission.attachments).toEqual([]);
  });

  it('sends via the Send button carrying the selected persona', () => {
    const onSubmit = vi.fn<(s: ComposerSubmit) => void>();
    mount(
      <Composer
        personas={PERSONAS}
        defaultPersonaId="default-trading-advisor"
        visionEnabled={false}
        onSubmit={onSubmit}
      />,
    );

    typeInto(getTextarea(), 'size my trade');

    // Switch persona via the native select.
    const select = document.querySelector('select[aria-label="Persona"]') as HTMLSelectElement;
    typeIntoSelect(select, 'risk-coach');

    const sendButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Send message',
    )!;
    act(() => sendButton.click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].personaId).toBe('risk-coach');
  });

  it('preserves text on CONVERSATION_TOO_LONG and starts a new conversation with the draft', () => {
    const onStartNewConversation = vi.fn();
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="CONVERSATION_TOO_LONG"
        onSubmit={vi.fn()}
        onStartNewConversation={onStartNewConversation}
      />,
    );

    typeInto(getTextarea(), 'carried-over draft');

    // The block message is shown and the typed text is preserved (not cleared).
    expect(document.querySelector('[data-testid="hard-cap-block"]')).not.toBeNull();
    expect(getTextarea().value).toBe('carried-over draft');

    const newConvButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'New conversation',
    )!;
    act(() => newConvButton.click());

    expect(onStartNewConversation).toHaveBeenCalledTimes(1);
    expect(onStartNewConversation.mock.calls[0]![0].text).toBe('carried-over draft');
  });

  it('hides the paperclip and ignores pasted images when vision is disabled', () => {
    mount(<Composer personas={PERSONAS} visionEnabled={false} onSubmit={vi.fn()} />);

    expect(
      Array.from(document.querySelectorAll('button')).some(
        (b) => b.getAttribute('aria-label') === 'Attach image',
      ),
    ).toBe(false);

    const textarea = getTextarea();
    const file = new File(['x'], 'chart.png', { type: 'image/png' });
    act(() => {
      const event = new Event('paste', { bubbles: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
      textarea.dispatchEvent(event);
    });

    // No preview rendered — the paste was a no-op for a non-vision model.
    expect(document.querySelector('[data-testid="attachment-previews"]')).toBeNull();
  });

  it('shows the paperclip when vision is enabled and never exceeds 4 attachments', async () => {
    mount(<Composer personas={PERSONAS} visionEnabled onSubmit={vi.fn()} />);

    expect(
      Array.from(document.querySelectorAll('button')).some(
        (b) => b.getAttribute('aria-label') === 'Attach image',
      ),
    ).toBe(true);

    const input = document.querySelector('[data-testid="file-input"]') as HTMLInputElement;
    const files = Array.from(
      { length: 6 },
      (_, i) => new File(['x'], `img${i}.png`, { type: 'image/png' }),
    );
    Object.defineProperty(input, 'files', { value: files, configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // allow the async FileReader/base64 reads to settle.
      await new Promise((r) => setTimeout(r, 50));
    });

    const previews = document.querySelectorAll('[data-testid="attachment-previews"] li');
    expect(previews.length).toBe(4);
  });

  it('rejects an image over the client pre-upload cap and accepts one within it (REQ-4.6)', async () => {
    // A tiny operator cap from the runtime-config seam; the encoded base64 of the
    // big file exceeds it, the small file does not.
    window.__TRADR_CONFIG__ = { advisorImageMaxBytes: 8 };
    mount(<Composer personas={PERSONAS} visionEnabled onSubmit={vi.fn()} />);

    const input = document.querySelector('[data-testid="file-input"]') as HTMLInputElement;
    const big = new File(['this-is-well-over-eight-base64-chars'], 'big.png', {
      type: 'image/png',
    });
    const small = new File(['x'], 'small.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [big, small], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
    });

    // Only the within-cap image survives; the oversized one is dropped pre-upload.
    const previews = document.querySelectorAll('[data-testid="attachment-previews"] li');
    expect(previews.length).toBe(1);

    delete window.__TRADR_CONFIG__;
  });

  it('renders NO banner for the retired TIER_LIMIT_EXCEEDED code (plan-tiers Task 13)', () => {
    // The server no longer emits it; the branch is replaced, so the code falls
    // through to the unknown-code path and renders nothing.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="TIER_LIMIT_EXCEEDED"
        onSubmit={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-testid="billing-refusal"]')).toBeNull();
  });

  it('ALLOWANCE_EXHAUSTED offers each remedy ONLY when available (REQ-8.2 matrix)', () => {
    // Both remedies available: buy credits + upgrade.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="ALLOWANCE_EXHAUSTED"
        remedies={{ buyCredits: true, upgrade: true }}
        onSubmit={vi.fn()}
      />,
    );
    let banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toContain(
      "You've used your free monthly turns — they reset at the start of next month (UTC).",
    );
    expect(bannerLinkLabels()).toEqual(['Buy credits', 'Upgrade to Pro']);
    unmountCurrent();

    // Subscription not purchasable: only buy credits.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="ALLOWANCE_EXHAUSTED"
        remedies={{ buyCredits: true, upgrade: false }}
        onSubmit={vi.fn()}
      />,
    );
    expect(bannerLinkLabels()).toEqual(['Buy credits']);
    unmountCurrent();

    // Neither available (remedies absent): message only, no dead-end links.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="ALLOWANCE_EXHAUSTED"
        onSubmit={vi.fn()}
      />,
    );
    banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner).not.toBeNull();
    expect(bannerLinkLabels()).toEqual([]);
  });

  it('fires upgrade_cta_clicked with surface composer on the upgrade CTA (REQ-13.1)', () => {
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="ALLOWANCE_EXHAUSTED"
        remedies={{ buyCredits: true, upgrade: true }}
        onSubmit={vi.fn()}
      />,
    );
    const upgrade = Array.from(document.querySelectorAll('[data-testid="billing-refusal"] a')).find(
      (a) => a.textContent === 'Upgrade to Pro',
    ) as HTMLAnchorElement;
    expect(upgrade.getAttribute('href')).toBe('/settings/billing');
    act(() => upgrade.click());
    expect(captureClientEvent).toHaveBeenCalledTimes(1);
    expect(captureClientEvent).toHaveBeenCalledWith('upgrade_cta_clicked', {
      surface: 'composer',
    });

    // The buy-credits link is NOT an upgrade CTA — no second event.
    const buyCredits = Array.from(
      document.querySelectorAll('[data-testid="billing-refusal"] a'),
    ).find((a) => a.textContent === 'Buy credits') as HTMLAnchorElement;
    act(() => buyCredits.click());
    expect(captureClientEvent).toHaveBeenCalledTimes(1);
  });

  it('INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE on a pinned conversation points to a new conversation (REQ-8.9c)', () => {
    const onStartNewConversation = vi.fn();
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE"
        remedies={{ buyCredits: true, upgrade: true }}
        allowanceModel="claude-haiku"
        pinnedConversation
        onSubmit={vi.fn()}
        onStartNewConversation={onStartNewConversation}
      />,
    );
    const banner = document.querySelector('[data-testid="billing-refusal"]')!;
    // The disclosure names the allowance model and, because the conversation is
    // pinned to its premium model, points at starting a new conversation.
    expect(banner.textContent).toContain('free monthly turns are available on claude-haiku');
    expect(banner.textContent).toContain('start a new conversation');
    expect(bannerLinkLabels()).toEqual(['Buy credits', 'Upgrade to Pro']);

    const newConv = Array.from(banner.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'New conversation',
    )!;
    act(() => newConv.click());
    expect(onStartNewConversation).toHaveBeenCalledTimes(1);
  });

  it('INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE on a NEW conversation offers no new-conversation escape (the picker is right there)', () => {
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE"
        remedies={{ buyCredits: true, upgrade: true }}
        allowanceModel="claude-haiku"
        onSubmit={vi.fn()}
      />,
    );
    const banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toContain('free monthly turns are available on claude-haiku');
    expect(banner.textContent).not.toContain('start a new conversation');
    expect(
      Array.from(banner.querySelectorAll('button')).some(
        (b) => b.textContent?.trim() === 'New conversation',
      ),
    ).toBe(false);
  });

  it('TIER_LIMIT_IMAGES shows the upgrade CTA and never blocks a text-only submission (REQ-9.2)', () => {
    const onSubmit = vi.fn();
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="TIER_LIMIT_IMAGES"
        remedies={{ buyCredits: true, upgrade: true }}
        onSubmit={onSubmit}
      />,
    );
    const banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toContain('Monthly image upload limit reached');
    // Upgrade is the remedy for the image quota; buy-credits does not apply.
    expect(bannerLinkLabels()).toEqual(['Upgrade to Pro']);

    // Text-only turns are unaffected: the refusal banner never disables submit
    // (unlike CONVERSATION_TOO_LONG's hard cap).
    const textarea = getTextarea();
    expect(textarea.disabled).toBe(false);
    typeInto(textarea, 'text-only still works');
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('BILLING_NOT_AVAILABLE gains the free-turns hint ONLY with allowance headroom (REQ-8.9c)', () => {
    // Gated Stripe-less instance with headroom: the message is annotated —
    // still no purchase links (honest posture unchanged).
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="BILLING_NOT_AVAILABLE"
        allowanceModel="claude-haiku"
        tierState={tierState({ allowanceUsed: 5 })}
        onSubmit={vi.fn()}
      />,
    );
    let banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toContain('Platform billing is not enabled on this instance.');
    expect(banner.textContent).toContain(
      'Free monthly turns are available on claude-haiku — start a new conversation.',
    );
    expect(banner.querySelector('a')).toBeNull();
    unmountCurrent();

    // Allowance exhausted: the exact untouched message, no hint.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="BILLING_NOT_AVAILABLE"
        allowanceModel="claude-haiku"
        tierState={tierState({ allowanceUsed: 25 })}
        onSubmit={vi.fn()}
      />,
    );
    banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toBe('Platform billing is not enabled on this instance.');
    unmountCurrent();

    // No tier state (self-host / loading): identical untouched message.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="BILLING_NOT_AVAILABLE"
        onSubmit={vi.fn()}
      />,
    );
    banner = document.querySelector('[data-testid="billing-refusal"]')!;
    expect(banner.textContent).toBe('Platform billing is not enabled on this instance.');
  });

  it('shows the ≥80% remaining hints from tier state and hides them below the threshold (REQ-11.6)', () => {
    // 20/25 turns (80%) and 16/20 images (80%): both hints, with remaining counts.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        tierState={tierState({ allowanceUsed: 20, imagesUsed: 16 })}
        onSubmit={vi.fn()}
      />,
    );
    const hints = document.querySelector('[data-testid="tier-usage-hints"]');
    expect(hints).not.toBeNull();
    expect(hints!.textContent).toContain('5 free turns left this month');
    expect(hints!.textContent).toContain('4 image uploads left');
    unmountCurrent();

    // Below the threshold: no hints element at all.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        tierState={tierState({ allowanceUsed: 10, imagesUsed: 5 })}
        onSubmit={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-testid="tier-usage-hints"]')).toBeNull();
    unmountCurrent();

    // No tier state (self-host / loading): no hints.
    mount(<Composer personas={PERSONAS} visionEnabled={false} onSubmit={vi.fn()} />);
    expect(document.querySelector('[data-testid="tier-usage-hints"]')).toBeNull();
  });

  it('still renders the existing billing-refusal branches and nothing for unknown codes', () => {
    // INSUFFICIENT_CREDITS keeps its billing link.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="INSUFFICIENT_CREDITS"
        onSubmit={vi.fn()}
      />,
    );
    let banner = document.querySelector('[data-testid="billing-refusal"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("You're out of credits.");
    expect(banner!.querySelector('a')?.getAttribute('href')).toBe('/settings/billing');
    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    // The remaining link-less branches still render their banners.
    for (const [code, message] of [
      ['BILLING_NOT_AVAILABLE', 'Platform billing is not enabled on this instance.'],
      ['MODEL_REQUIRED', 'Select a provider and model to start.'],
      ['MODEL_NOT_AVAILABLE', "This model isn't available on credits"],
    ] as const) {
      mount(
        <Composer personas={PERSONAS} visionEnabled={false} errorCode={code} onSubmit={vi.fn()} />,
      );
      banner = document.querySelector('[data-testid="billing-refusal"]');
      expect(banner, code).not.toBeNull();
      expect(banner!.textContent).toContain(message);
      act(() => mounted!.root.unmount());
      mounted!.container.remove();
      mounted = null;
    }

    // An unknown code stays off the allowlist — no banner at all.
    mount(
      <Composer
        personas={PERSONAS}
        visionEnabled={false}
        errorCode="SOME_UNKNOWN_CODE"
        onSubmit={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-testid="billing-refusal"]')).toBeNull();
  });
});

function typeIntoSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
