/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-web-to-shared-lib',
      severity: 'error',
      comment:
        'apps/web must not import from @tradr/shared/src/lib/* — computation primitives live in schemas/, or backend-only. Expose a new shared surface via packages/shared/src/index.ts if the UI genuinely needs it.',
      from: { path: '^apps/web/' },
      to: { path: '^packages/shared/src/lib/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    includeOnly: '^(apps|packages)/',
    exclude: {
      path: ['\\.test\\.tsx?$', '\\.spec\\.tsx?$', 'node_modules', 'dist'],
    },
  },
};
