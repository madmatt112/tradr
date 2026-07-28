import type { Database } from '@/db';

export async function withTransaction<T>(
  db: Database,
  callback: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(callback);
}
