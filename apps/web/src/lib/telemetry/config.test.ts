import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTelemetryConfig, isPostHogClientConfigured } from './config';

describe('getTelemetryConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {} when window is absent (SSR)', () => {
    vi.stubGlobal('window', undefined);
    expect(getTelemetryConfig()).toEqual({});
  });

  it('returns {} when __TRADR_CONFIG__ is absent', () => {
    vi.stubGlobal('window', {});
    expect(getTelemetryConfig()).toEqual({});
  });

  it('returns {} when __TRADR_CONFIG__ is empty', () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: {} });
    expect(getTelemetryConfig()).toEqual({});
  });

  it('returns each telemetry field when present', () => {
    vi.stubGlobal('window', {
      __TRADR_CONFIG__: {
        apiBaseUrl: 'https://api.example.com',
        posthogPublicKey: 'phc_abc123',
        posthogPublicHost: 'https://us.i.posthog.com',
      },
    });
    expect(getTelemetryConfig()).toEqual({
      posthogPublicKey: 'phc_abc123',
      posthogPublicHost: 'https://us.i.posthog.com',
    });
  });

  it('does not include apiBaseUrl', () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: { apiBaseUrl: 'https://api.example.com' } });
    expect(getTelemetryConfig()).not.toHaveProperty('apiBaseUrl', 'https://api.example.com');
    expect(getTelemetryConfig()).toEqual({});
  });
});

describe('isPostHogClientConfigured', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when window is absent', () => {
    vi.stubGlobal('window', undefined);
    expect(isPostHogClientConfigured()).toBe(false);
  });

  it('is false when posthogPublicKey is absent', () => {
    vi.stubGlobal('window', {
      __TRADR_CONFIG__: { posthogPublicHost: 'https://us.i.posthog.com' },
    });
    expect(isPostHogClientConfigured()).toBe(false);
  });

  it('is false when posthogPublicKey is an empty string', () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: { posthogPublicKey: '' } });
    expect(isPostHogClientConfigured()).toBe(false);
  });

  it('is true when posthogPublicKey is a non-empty string', () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: { posthogPublicKey: 'phc_abc123' } });
    expect(isPostHogClientConfigured()).toBe(true);
  });
});
