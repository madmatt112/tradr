import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Glob limited to *.schema.ts so co-located *.schema.test.ts files (which import
  // vitest) are not bundled by drizzle-kit during generate/push.
  schema: './src/db/schema/*.schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
});
