import { logger } from '@/lib/logger';

import { runPostMigrations } from './migrate';

async function main() {
  await runPostMigrations();
  logger.info('Post-migrations complete');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Post-migrations failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
