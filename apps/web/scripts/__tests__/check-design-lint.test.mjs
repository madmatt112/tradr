import { describe, it, expect } from 'vitest';

import { lintContent, ALLOWED_STEPS, TABULAR_EXEMPT } from '../check-design-lint.mjs';

// Helper: collect the `check` kinds present in a finding list.
function checks(findings) {
  return findings.map((f) => f.check);
}

describe('RAW-PALETTE-CLASS check', () => {
  it('flags a raw palette class with file:line', () => {
    const f = lintContent('features/foo/Bar.tsx', `const a = 1;\n<span className="text-red-600" />`);
    const palette = f.filter((x) => x.check === 'RAW-PALETTE-CLASS');
    expect(palette).toHaveLength(1);
    expect(palette[0]).toMatchObject({
      file: 'features/foo/Bar.tsx',
      line: 2,
      match: 'text-red-600',
    });
  });

  it('matches the full canonical character class (every prefix×palette family)', () => {
    const samples = [
      'bg-slate-50',
      'border-emerald-500',
      'ring-indigo-300',
      'fill-rose-400',
      'stroke-zinc-700',
      'placeholder-gray-400',
      'divide-neutral-200',
      'from-sky-500',
      'via-violet-400',
      'to-amber-300',
      'outline-orange-500',
      'decoration-pink-500',
      'shadow-blue-500',
      'accent-purple-600',
      'caret-yellow-500',
      'text-green-600',
      'text-grey-500',
      'text-stone-900',
    ];
    for (const s of samples) {
      const f = lintContent('a.tsx', `class="${s}"`);
      expect(checks(f), s).toContain('RAW-PALETTE-CLASS');
    }
  });

  it('does not flag a semantic token class', () => {
    const f = lintContent('a.tsx', '<span className="text-muted-foreground bg-card" />');
    expect(checks(f)).not.toContain('RAW-PALETTE-CLASS');
  });
});

describe('SPACING-LADDER check', () => {
  it('flags an off-ladder integer step (py-10) with file:line', () => {
    const f = lintContent('components/EmptyState.tsx', `<div className="gap-3 py-10" />`);
    const spacing = f.filter((x) => x.check === 'SPACING-LADDER');
    expect(spacing).toHaveLength(1);
    expect(spacing[0]).toMatchObject({ line: 1, match: 'py-10' });
  });

  it('flags pl-5 (off-ladder)', () => {
    const f = lintContent('a.tsx', `<ul className="list-disc pl-5" />`);
    expect(f.some((x) => x.check === 'SPACING-LADDER' && x.match === 'pl-5')).toBe(true);
  });

  it('passes every on-ladder integer step', () => {
    for (const step of ALLOWED_STEPS) {
      const f = lintContent('a.tsx', `class="p-${step} gap-${step}"`);
      expect(checks(f), `step ${step}`).not.toContain('SPACING-LADDER');
    }
  });

  it('does not flag fractional shadcn half-steps (they are not integer steps)', () => {
    const f = lintContent('a.tsx', `class="py-1.5 gap-1.5 px-2.5 space-y-0.5"`);
    expect(checks(f)).not.toContain('SPACING-LADDER');
  });

  it('does not flag arbitrary [Npx] chart heights / drawer widths', () => {
    const f = lintContent('a.tsx', `class="h-[280px] w-[420px]"`);
    expect(checks(f)).not.toContain('SPACING-LADDER');
  });
});

describe('TYPE-SCALE check', () => {
  it('flags an arbitrary text-[…] size with file:line', () => {
    const f = lintContent('a.tsx', `\n<span className="text-[13px]" />`);
    const type = f.filter((x) => x.check === 'TYPE-SCALE');
    expect(type).toHaveLength(1);
    expect(type[0]).toMatchObject({ line: 2, match: 'text-[13px]' });
  });

  it('does not flag a ladder text size', () => {
    const f = lintContent('a.tsx', '<span className="text-sm text-lg" />');
    expect(checks(f)).not.toContain('TYPE-SCALE');
  });
});

describe('PRIMITIVE-BYPASS GUARD — pnlColorClass', () => {
  it('flags a pnlColorClass usage with file:line', () => {
    const f = lintContent('a.tsx', `import { pnlColorClass } from '@/lib/format';`);
    expect(f.some((x) => x.check === 'BYPASS-PNLCOLORCLASS')).toBe(true);
  });
});

describe('PRIMITIVE-BYPASS GUARD — tabular-nums', () => {
  it('flags inline tabular-nums OUTSIDE the exempt set', () => {
    const f = lintContent('features/billing/BillingPanel.tsx', `<p className="tabular-nums" />`);
    expect(f.some((x) => x.check === 'BYPASS-TABULAR-NUMS')).toBe(true);
  });

  it('flags font-variant-numeric outside the exempt set', () => {
    const f = lintContent('a.tsx', `style={{ fontVariantNumeric: 'tabular' }} font-variant-numeric`);
    expect(f.some((x) => x.check === 'BYPASS-TABULAR-NUMS')).toBe(true);
  });

  it('does NOT flag tabular-nums inside the primitive (Numeric.tsx)', () => {
    const f = lintContent('components/Numeric.tsx', `<span className="tabular-nums" />`);
    expect(checks(f)).not.toContain('BYPASS-TABULAR-NUMS');
  });

  it('does NOT flag tabular-nums inside the three exempt chart files', () => {
    for (const file of [
      'features/performance/components/PerformanceBarChart.tsx',
      'features/performance/components/EquityCurveChart.tsx',
      'features/admin/components/UsageChart.tsx',
    ]) {
      const f = lintContent(file, `<text className="tabular-nums" />`);
      expect(checks(f), file).not.toContain('BYPASS-TABULAR-NUMS');
    }
  });

  it('the allowlist is an EXPLICIT three-path set, NOT a *Chart*.tsx glob', () => {
    // These near-miss filenames MUST still be guarded (the glob over-matches).
    for (const file of [
      'features/performance/components/ChartChunkStaleBanner.tsx',
      'features/performance/components/EquityCurveChartSkeleton.tsx',
      'features/dashboard/widgets/PerformanceChartWidget.tsx',
    ]) {
      expect(TABULAR_EXEMPT.has(file), file).toBe(false);
      const f = lintContent(file, `<span className="tabular-nums" />`);
      expect(f.some((x) => x.check === 'BYPASS-TABULAR-NUMS'), file).toBe(true);
    }
  });
});

describe('clean fixture', () => {
  it('reports nothing for a fully on-token, on-ladder, primitive-routed file', () => {
    const clean = [
      `import { Numeric } from '@/components/Numeric';`,
      ``,
      `export function Clean() {`,
      `  return (`,
      `    <div className="flex flex-col gap-4 p-6 text-muted-foreground">`,
      `      <span className="text-sm font-medium bg-card border-border">label</span>`,
      `      <Numeric value={1234} />`,
      `    </div>`,
      `  );`,
      `}`,
    ].join('\n');
    const f = lintContent('features/clean/Clean.tsx', clean);
    expect(f).toHaveLength(0);
  });
});

describe('combined fixture — every check fires once', () => {
  it('reports all five finding kinds from a single dirty file', () => {
    const dirty = [
      `import { pnlColorClass } from '@/lib/format';`, // BYPASS-PNLCOLORCLASS
      `<span className="text-red-600" />`, //              RAW-PALETTE-CLASS
      `<div className="py-10" />`, //                      SPACING-LADDER
      `<p className="text-[13px]" />`, //                  TYPE-SCALE
      `<b className="tabular-nums" />`, //                 BYPASS-TABULAR-NUMS
    ].join('\n');
    const f = lintContent('features/dirty/Dirty.tsx', dirty);
    const kinds = new Set(checks(f));
    expect(kinds).toEqual(
      new Set([
        'BYPASS-PNLCOLORCLASS',
        'RAW-PALETTE-CLASS',
        'SPACING-LADDER',
        'TYPE-SCALE',
        'BYPASS-TABULAR-NUMS',
      ]),
    );
  });
});
