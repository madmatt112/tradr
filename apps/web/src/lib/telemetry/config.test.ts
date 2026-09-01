import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFeedbackSurveyWarnForTests,
  getFeedbackSurveyIds,
  getTelemetryConfig,
  isFeedbackSurveyConfigured,
  isPostHogClientConfigured,
} from './config';

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
        posthogPublicEnvironment: 'production',
        feedbackSurvey: 'sid:rid:tid',
      },
    });
    expect(getTelemetryConfig()).toEqual({
      posthogPublicKey: 'phc_abc123',
      posthogPublicHost: 'https://us.i.posthog.com',
      posthogPublicEnvironment: 'production',
      feedbackSurvey: 'sid:rid:tid',
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

describe('getFeedbackSurveyIds / isFeedbackSurveyConfigured', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetFeedbackSurveyWarnForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  const stub = (cfg: Record<string, unknown>) => vi.stubGlobal('window', { __TRADR_CONFIG__: cfg });

  it('is false with an empty config, no warn', () => {
    stub({});
    expect(isFeedbackSurveyConfigured()).toBe(false);
    expect(getFeedbackSurveyIds()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is false with the key alone (survey absent), no warn', () => {
    stub({ posthogPublicKey: 'phc_abc123' });
    expect(isFeedbackSurveyConfigured()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is false with a survey value but no key, no warn', () => {
    stub({ feedbackSurvey: 'sid:rid:tid' });
    expect(isFeedbackSurveyConfigured()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is false with the key and an empty survey string, no warn', () => {
    stub({ posthogPublicKey: 'phc_abc123', feedbackSurvey: '' });
    expect(isFeedbackSurveyConfigured()).toBe(false);
    expect(getFeedbackSurveyIds()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is true with the key and a valid "a:b:c" value, and parses the ids', () => {
    stub({ posthogPublicKey: 'phc_abc123', feedbackSurvey: 'a:b:c' });
    expect(isFeedbackSurveyConfigured()).toBe(true);
    expect(getFeedbackSurveyIds()).toEqual({
      surveyId: 'a',
      ratingQuestionId: 'b',
      textQuestionId: 'c',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['two segments', 'a:b'],
    ['four segments', 'a:b:c:d'],
    ['an empty segment', 'a::c'],
    ['a whitespace segment', 'a:b :c'],
  ])('is false with the key and %s, warning once', (_label, value) => {
    stub({ posthogPublicKey: 'phc_abc123', feedbackSurvey: value });
    expect(isFeedbackSurveyConfigured()).toBe(false);
    expect(getFeedbackSurveyIds()).toBeUndefined();
    // Repeated render-path calls must not repeat the warn (latched at module scope).
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
