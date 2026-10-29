import { z } from 'zod';

// The strict CSP (apps/web/scripts/csp.mjs) ships no 'unsafe-eval', so zod 4's
// `new Function` JIT probe reports a securitypolicyviolation even though it's caught.
z.config({ jitless: true });
