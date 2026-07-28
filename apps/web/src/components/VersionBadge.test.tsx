// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { appVersion } from '@/lib/api';

import { VersionBadge } from './VersionBadge';

afterEach(() => {
  cleanup();
  delete window.__TRADR_CONFIG__;
});

describe('appVersion', () => {
  it("falls back to 'localdev' when config.js is absent (local dev)", () => {
    delete window.__TRADR_CONFIG__;
    expect(appVersion()).toBe('localdev');
  });

  it("falls back to 'localdev' when config.js omits appVersion", () => {
    window.__TRADR_CONFIG__ = { apiBaseUrl: 'https://api.example.com/api' };
    expect(appVersion()).toBe('localdev');
  });

  it('returns the deploy-stamped string when present', () => {
    window.__TRADR_CONFIG__ = { appVersion: 'v0.1.0-ab67fad' };
    expect(appVersion()).toBe('v0.1.0-ab67fad');
  });
});

describe('VersionBadge', () => {
  it('renders the stamped version', () => {
    window.__TRADR_CONFIG__ = { appVersion: 'v0.1.0-ab67fad' };
    render(<VersionBadge />);
    expect(screen.getByText('v0.1.0-ab67fad')).toBeTruthy();
  });

  it('renders the localdev fallback and never intercepts clicks', () => {
    render(<VersionBadge />);
    const el = screen.getByText('localdev');
    expect(el.className).toContain('pointer-events-none');
  });
});
