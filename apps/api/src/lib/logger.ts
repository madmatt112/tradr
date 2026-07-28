import { AsyncLocalStorage } from 'node:async_hooks';

interface LogContext {
  requestId: string;
  userId?: string;
  feature?: string;
}

export const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Mutate the current ALS store's `userId` so every subsequent log in this
 * request carries it. No-op when there is no store (safe regardless of
 * middleware order).
 */
export function setLogUser(userId: string) {
  const store = asyncLocalStorage.getStore();
  if (store) store.userId = userId;
}

function log(level: string, message: string, extra?: Record<string, unknown>) {
  const store = asyncLocalStorage.getStore();
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    requestId: store?.requestId,
    ...(store?.userId ? { userId: store.userId } : {}),
    ...(store?.feature ? { feature: store.feature } : {}),
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, extra?: Record<string, unknown>) => log('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => log('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => log('error', message, extra),
  debug: (message: string, extra?: Record<string, unknown>) => log('debug', message, extra),
};
