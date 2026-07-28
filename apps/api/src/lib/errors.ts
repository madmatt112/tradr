export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(404, 'NOT_FOUND', `${resource} ${id} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public details?: Record<string, string>,
    public fields?: Array<{ path: string; code: string; message: string }>,
  ) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class RateLimitError extends AppError {
  constructor(public retryAfter: number) {
    super(429, 'RATE_LIMITED', 'Too many requests');
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'Request timed out') {
    super(503, 'TIMEOUT', message);
  }
}

export class ClientAbortError extends AppError {
  constructor(message = 'Client disconnected') {
    super(503, 'CLIENT_ABORT', message);
  }
}

export class InvalidTimezoneError extends AppError {
  constructor(message = 'Invalid timezone') {
    super(400, 'INVALID_TIMEZONE', message);
  }
}

export class InvariantViolationError extends AppError {
  constructor(message: string) {
    super(500, 'INVARIANT_VIOLATION', message);
  }
}

export class HookAlreadyRegisteredError extends AppError {
  constructor(name: string) {
    super(500, 'HOOK_ALREADY_REGISTERED', `Hook '${name}' already registered`);
  }
}

export class MissingRateError extends AppError {
  constructor(
    public base: string,
    public quote: string,
    public asOf: string,
  ) {
    super(422, 'MISSING_RATE', `No exchange rate for ${base}->${quote} on ${asOf}`);
  }
}
