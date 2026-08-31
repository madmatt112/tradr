// The ONLY place the SPA reads frontend telemetry config. Config is delivered
// at runtime via /config.js → window.__TRADR_CONFIG__ (REQ-6.2). Frontend keys
// are *Public* to signal they are publishable, distinct from the api
// container's secret-side names. Every field is optional: a missing field means
// that surface is absent (REQ-1.2). The frontend PostHog surface gates
// independently of the backend one (REQ-1.1).

export interface TelemetryConfig {
  posthogPublicKey?: string;
  posthogPublicHost?: string;
  posthogPublicEnvironment?: string;
  feedbackSurvey?: string;
}

// Parsed shape of feedbackSurvey ("<surveyId>:<ratingQid>:<textQid>"). Derived
// from config at read time, held in memory only — never persisted, never sent to
// any Tradr endpoint; used solely as event-property values (user-feedback REQ-1.3).
export interface FeedbackSurveyIds {
  surveyId: string;
  ratingQuestionId: string;
  textQuestionId: string;
}

/**
 * Read the frontend telemetry fields from window.__TRADR_CONFIG__. Returns an
 * empty object when window or the config is absent (SSR-safe guard mirroring
 * resolveApiUrl in api.ts).
 */
export function getTelemetryConfig(): TelemetryConfig {
  if (typeof window === 'undefined') return {};
  const cfg = window.__TRADR_CONFIG__;
  if (!cfg) return {};
  return {
    posthogPublicKey: cfg.posthogPublicKey,
    posthogPublicHost: cfg.posthogPublicHost,
    posthogPublicEnvironment: cfg.posthogPublicEnvironment,
    feedbackSurvey: cfg.feedbackSurvey,
  };
}

export function isPostHogClientConfigured(): boolean {
  return !!getTelemetryConfig().posthogPublicKey;
}

// One warn per page load for a malformed (non-empty) feedbackSurvey value,
// latched at module scope so render-path calls never repeat it (REQ-1.3). Reset
// only by __resetFeedbackSurveyWarnForTests, the __reset*ForTests house pattern.
let feedbackSurveyWarned = false;

/**
 * Parse feedbackSurvey into its three ids, or undefined when the feedback
 * surface must stay absent. Returns ids only when posthogPublicKey is present
 * AND the value is "<surveyId>:<ratingQid>:<textQid>" — exactly three
 * ':'-separated segments, each non-empty and whitespace-free. Absent /
 * undefined / "" → undefined silently (every hosted deploy without a survey
 * writes ""). Any other malformed value → undefined plus one console.warn.
 */
export function getFeedbackSurveyIds(): FeedbackSurveyIds | undefined {
  const cfg = getTelemetryConfig();
  if (!cfg.posthogPublicKey) return undefined;

  const value = cfg.feedbackSurvey;
  if (!value) return undefined; // absent / undefined / "" — silent

  const parts = value.split(':');
  const valid = parts.length === 3 && parts.every((part) => part !== '' && !/\s/.test(part));
  if (!valid) {
    if (!feedbackSurveyWarned) {
      feedbackSurveyWarned = true;
      console.warn(
        'Ignoring malformed feedbackSurvey config: expected "<surveyId>:<ratingQuestionId>:<textQuestionId>".',
      );
    }
    return undefined;
  }

  const [surveyId, ratingQuestionId, textQuestionId] = parts;
  return { surveyId, ratingQuestionId, textQuestionId };
}

// The single predicate every consumer uses to gate the feedback surface (REQ-1.3).
export function isFeedbackSurveyConfigured(): boolean {
  return getFeedbackSurveyIds() !== undefined;
}

// Reset the module-scope warn latch. Test-only (__reset*ForTests house pattern).
export function __resetFeedbackSurveyWarnForTests(): void {
  feedbackSurveyWarned = false;
}
