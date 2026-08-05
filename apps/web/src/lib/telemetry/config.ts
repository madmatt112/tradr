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
  };
}

export function isPostHogClientConfigured(): boolean {
  return !!getTelemetryConfig().posthogPublicKey;
}
