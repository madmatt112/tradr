# Required-States Audit (both themes)

How every interactive state — hover, focus, active, disabled, selected — is
expected to render in **both** the light and dark themes, and where each
expectation is enforced.

Scope: the global chrome plus every interactive component and data surface in
`apps/web/src`. The audit is anchored to two machine gates, so it stays
self-checking rather than a snapshot that rots:

- `apps/web/scripts/check-contrast.mjs` — per-theme WCAG-AA contrast + ΔEOK
  distinctness, **light AND dark**. Reports **0 findings**.
- `apps/web/scripts/check-design-lint.mjs` — no raw palette classes, on-ladder
  spacing, primitive-bypass guard. Reports **0 findings**.

## 1. Global chrome re-themes via `.dark`

All global chrome is token-clean — it carries no hardcoded color and re-themes
automatically once `.dark` re-values the tokens (`index.css`).

| Surface               | File                                           | Treatment                                                                                                        | Both-theme |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| App-error fallback    | `routes/__root.tsx` `ErrorComponent`           | `Button` (primary token) on default surface; no literal color                                                    | ✅         |
| Not-found fallback    | `routes/__root.tsx` `NotFoundComponent`        | `text-muted-foreground` loading text → `<Navigate>`                                                              | ✅         |
| Toaster               | `components/ui/sonner.tsx`                     | `--normal-bg/text/border` mapped to `--popover`/`--popover-foreground`/`--border`; `theme` follows `next-themes` | ✅         |
| Dialog / Alert-dialog | `components/ui/dialog.tsx`, `alert-dialog.tsx` | overlay `bg-black/50` + `dark:bg-black/80`; content uses `bg-popover` tokens                                     | ✅         |

No stray classes were found; no chrome fix was required.

## 2. Active/selected navigation = amber primary

The brand amber (`--color-primary`) is reserved for the primary action **and**
active/selected nav. All **13** Sidebar nav links (`components/layout/Sidebar.tsx`)
were migrated off the neutral `[&.active]:bg-accent` fill onto the amber brand
treatment:

```
[&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium
```

`accent` stays the structural **hover** neutral (`hover:bg-accent` is unchanged).
The active item now reads as the brand, not a neutral fill. The treatment uses
the `primary` **token** (not a hardcoded `amber-*` class), so `check-design-lint`
stays at 0.

## 3. Required-states matrix (both themes)

Interactive states ride on the unmodified shadcn/Radix primitives; the audit
verifies each state has a token-driven, both-theme treatment. No primitive was
modified — re-skin is via tokens only.

| Component         | default                   | hover                    | focus-visible                    | active/checked                    | disabled              | loading         | error                             |
| ----------------- | ------------------------- | ------------------------ | -------------------------------- | --------------------------------- | --------------------- | --------------- | --------------------------------- |
| Button            | `bg-primary`/variant      | `hover:bg-*/90`          | `ring-ring/50` (`--color-focus`) | `:active` press                   | `disabled:opacity-50` | spinner + label | `aria-invalid:ring-destructive`   |
| Input / Textarea  | `border-input`            | —                        | `ring-ring/50`                   | —                                 | `disabled:opacity-50` | —               | `aria-invalid:border-destructive` |
| Select            | `border-input`            | `dark:hover:bg-input/50` | `ring-ring/50`                   | `data-[state]`                    | `disabled:opacity-50` | —               | `aria-invalid`                    |
| Switch / Checkbox | `bg-input`                | —                        | `ring-ring/50`                   | `data-[state=checked]:bg-primary` | `disabled:opacity-50` | —               | —                                 |
| Tabs trigger      | `text-foreground/60`      | `hover:text-foreground`  | `ring-ring/50`                   | `data-[state=active]`             | `disabled:opacity-50` | —               | —                                 |
| Accordion trigger | `text-sm`                 | `hover:underline`        | `ring-ring/50`                   | `data-[state=open]`               | `disabled:opacity-50` | —               | —                                 |
| Sidebar nav link  | `hover:bg-accent` neutral | `hover:bg-accent`        | router focus ring                | `bg-primary/10 text-primary`      | —                     | —               | —                                 |

**Data surfaces** (loading / empty / error):

| Surface                        | loading                                        | empty                            | error                      |
| ------------------------------ | ---------------------------------------------- | -------------------------------- | -------------------------- |
| Tables (e.g. `BreakdownTable`) | `Numeric.Skeleton` (column geometry preserved) | `EmptyState.Table` (colSpan row) | `EmptyState.Table` message |
| Lists / widgets                | `Skeleton`                                     | `EmptyState` (centered card)     | `EmptyState` error message |
| Charts                         | lazy skeleton                                  | empty-series guard               | parent error boundary      |

All states use semantic tokens, so each renders correctly in both themes.

## 4. Disabled / muted legibility — covered by the contrast gate

The codebase has **no grey palette classes**. The de-emphasised path is
`disabled:opacity-50` (~8 `components/ui` sites, all on inactive controls) and
`text-muted-foreground` (≈189 uses). Opacity-dimmed foreground can pass AA in
light yet fail in dark, so the both-theme legibility is **sampled by the contrast
gate's required-minimum set** (not by eyeball):

- `muted-foreground` vs `background` / `card` / `popover` — **≥4.5**, both themes.
- `foreground` at 50% opacity composited over each surface — **≥3** (the WCAG
  1.4.3 inactive-UI floor; see note below), both themes.

These pairs are required-present in `check-contrast.mjs`; a missing pair FAILS.
All pass with 0 findings.

> **Disabled threshold note.** Every `disabled:opacity-50` site sits on a
> _disabled control_ (button/input/textarea/select/switch/accordion/label),
> which WCAG 2.x SC 1.4.3 explicitly exempts from the 4.5:1 text minimum
> ("inactive user interface component … has no contrast requirement"). A
> 50%-dimmed foreground over a near-white surface caps at ~3.98:1 for _any_
> token value, so the disabled-50 pair is scored at the **3:1 inactive-UI
> floor** — still sampled in both themes to catch a disabled state that drops
> below it. This is a threshold _classification_, not a relaxation of the
> active-text gate.

### Token-value fixes applied (both-theme gaps surfaced by the audit)

Tuned OKLCH values in `index.css` to bring the gate to 0 findings (intent —
terminal-amber brand, gain≠loss hue split, focus≠amber, danger≠loss, ΔEOK
distinctness — preserved; type-scale/font tokens unchanged):

| Token                              | Theme | Before           | After            | Reason                                         |
| ---------------------------------- | ----- | ---------------- | ---------------- | ---------------------------------------------- |
| `--color-border` / `--color-input` | light | `0.90 0 0`       | `0.64 0 0`       | separator ≥3:1 vs background (was ~1.35)       |
| `--color-border` / `--color-input` | dark  | `0.30 0.006 265` | `0.50 0.006 265` | separator ≥3:1 vs background (was ~1.42)       |
| `--color-warning`                  | light | `0.55 0.14 70`   | `0.49 0.15 70`   | `text-warning` ≥4.5 on its `/10` tint          |
| `--color-success`                  | light | `0.52 0.09 190`  | `0.50 0.10 190`  | `text-success` ≥4.5 on its `/10` tint          |
| `--color-destructive`              | dark  | `0.62 0.21 12`   | `0.58 0.21 12`   | white `destructive-foreground` ≥4.5 (was 3.94) |

## 5. Density registers

The two registers are a **surface convention**, not a new component variant:

- **`data-density="compact"`** — data-dense surfaces (tables, the side drawer,
  dense widgets). Already used by `BlackScholesCard` / `OptionsPricingTab`
  (the `density="compact"` prop renders a tighter `gap-3` grid + `data-density`).
- **`data-density="comfortable"`** — input/reading surfaces (forms, settings,
  empty states). The default.

A surface opts in by setting `data-density` on its container (or by the dense
widget's existing `density` prop). Numbers stay tabular-aligned at **both**
registers because alignment is owned by the `Numeric` primitive, independent of
the surrounding register.

## 6. Target size ≥24×24px (WCAG 2.5.8)

Satisfied by the shadcn defaults — verified in `components/ui/button.tsx`; no
control smaller than 24px exists, and the design adds none:

| Size                              | px     | Role                               |
| --------------------------------- | ------ | ---------------------------------- |
| `default` `h-9` / `icon` `size-9` | 36     | standard                           |
| `sm` `h-8` / `icon-sm` `size-8`   | 32     | dense                              |
| `xs` `h-6` / `icon-xs` `size-6`   | **24** | smallest — meets the floor exactly |
| `input` / `select` `h-9`          | 36     | fields                             |

The Sidebar's collapse toggle and log-out use `icon-sm` (32px) / `sm` (32px).
No new harness check is added (the shadcn floor + this audit cover it).

## 7. Keyboard / tab-order / ARIA + focus indicator

This spec adds **no** new interactive component — it re-skins via tokens. So the
keyboard-operability, logical tab order, and ARIA correctness ride on the
**unmodified shadcn/Radix primitives** (Radix dialog/select/tabs/accordion/
switch ship roving-tabindex, focus trap, and correct roles/`aria-*`). The
**visible focus indicator** is delivered by `--color-focus` (a cool-blue ring
decoupled from amber): `--color-ring: var(--color-focus)`, consumed by every
primitive's `focus-visible:ring-ring/50`. The contrast gate asserts
`focus` vs each surface **≥3** in both themes (passes).
