// apps/web/src/features/options/lib/formToWireInput.ts
import { BlackScholesInputSchema, type BlackScholesInput } from '@tradr/shared';

export type FormStringState = {
  S: string;
  K: string;
  T: string;
  sigma: string;
  r: string;
  q: string;
  type: 'call' | 'put';
};

export type FormConversionResult =
  | { ok: true; value: BlackScholesInput }
  | { ok: false; fieldErrors: Partial<Record<keyof FormStringState, string>> };

export function formToWireInput(form: FormStringState): FormConversionResult {
  const fieldErrors: Partial<Record<keyof FormStringState, string>> = {};

  const parseNum = (
    key: keyof FormStringState,
    raw: string,
    required: boolean,
  ): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (required) fieldErrors[key] = 'Required';
      return undefined;
    }
    // Reject empty after trim, and reject Euro-locale comma decimals — surface
    // an explicit error instead of silently producing 0 or 1.234 from '1,234'.
    if (/,/.test(trimmed)) {
      fieldErrors[key] = "Use '.' as decimal separator (e.g. 0.30)";
      return undefined;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      fieldErrors[key] = 'Must be a finite number';
      return undefined;
    }
    return n;
  };

  const S = parseNum('S', form.S, true);
  const K = parseNum('K', form.K, true);
  const T = parseNum('T', form.T, true);
  const sigma = parseNum('sigma', form.sigma, true);
  const r = parseNum('r', form.r, true);
  const q = parseNum('q', form.q, false); // optional; '' → undefined → wire .default(0)

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  // All required fields parsed. Now run the wire schema for bound checks.
  const candidate: Record<string, unknown> = { S, K, T, sigma, r, type: form.type };
  if (q !== undefined) candidate.q = q;

  const result = BlackScholesInputSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path[0] as keyof FormStringState | undefined;
      if (path) fieldErrors[path] = issue.message;
    }
    return { ok: false, fieldErrors };
  }
  return { ok: true, value: result.data };
}
