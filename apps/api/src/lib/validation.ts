import { zValidator } from '@hono/zod-validator';
import type { ZodError, ZodSchema } from 'zod';

import { ValidationError } from './errors';

type ValidationTarget = 'json' | 'query' | 'param' | 'header' | 'cookie' | 'form';

function formatZodErrors(error: ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    details[path] = issue.message;
  }
  return details;
}

function formatZodFields(error: ZodError): Array<{ path: string; code: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '_root',
    code: issue.code,
    message: issue.message,
  }));
}

export function validate<T extends ZodSchema>(target: ValidationTarget, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ValidationError(
        'Validation failed',
        formatZodErrors(result.error),
        formatZodFields(result.error),
      );
    }
  });
}
