// PlatformModelPicker — provider/model chooser for a no-BYOK platform conversation
// (wallet-billing REQ-4.3, REQ-5.1).
//
// Shown only on a NEW conversation when the user has no BYOK key but platform
// billing is enabled. The options come exclusively from GET /api/billing/config
// `models` (the platform-priced, platform-key-configured set), so the picker can
// never select an unpriced or unconfigured model. The selection becomes the
// `providerOverride.{ providerId, model }` sent on the first stream request — the
// producer side of the field Task 11 consumes.
//
// Uses native <select>s to match the Composer's persona selector (the advisor
// surface's established chooser pattern) rather than the radix Select used in the
// settings cards.

import type { BillingModel, ProviderId } from '@tradr/shared';

import { Label } from '@/components/ui/label';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

const SELECT_CLASS =
  'h-9 cursor-pointer rounded-md border border-input bg-transparent px-2 text-sm';

export interface PlatformModelPickerProps {
  /** The platform-priced provider/model set from GET /api/billing/config. */
  models: BillingModel[];
  /** Currently selected override, or null when nothing is chosen yet. */
  value: BillingModel | null;
  /** Fired when the user picks a provider/model pair. */
  onChange: (selection: BillingModel) => void;
  /** Disabled while a stream is in flight. */
  disabled?: boolean;
  /**
   * True when tier state shows free platform-turn headroom (plan-tiers
   * REQ-8.9a/b). Combined with a config-marked allowance model this activates
   * the "includes free monthly turns" marking and allowance-first ordering;
   * absent/false (self-host, exhausted allowance, tier query in flight) leaves
   * ordering and the first-priced auto-select byte-identical to today.
   */
  allowanceHeadroom?: boolean;
}

export function PlatformModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  allowanceHeadroom = false,
}: PlatformModelPickerProps) {
  // Allowance marking/ordering activate ONLY when the config marks an allowance
  // model (itself gating-gated, D16) AND tier state shows headroom (plan-tiers
  // Component 12); otherwise behaviour is unchanged (self-host parity).
  const allowanceActive = allowanceHeadroom && models.some((m) => m.allowance === true);

  // Allowance-first ordering (REQ-8.9b): within a provider the allowance model
  // sorts first (stable sort — the rest keep rate-table order). Inactive ⇒ the
  // original order, so the first-priced auto-select below is unchanged.
  const orderModels = (list: BillingModel[]): BillingModel[] =>
    allowanceActive
      ? [...list].sort((a, b) => Number(b.allowance === true) - Number(a.allowance === true))
      : list;

  // Distinct providers that have at least one priced model.
  const providers = Array.from(new Set(models.map((m) => m.providerId)));
  const selectedProvider = value?.providerId ?? null;
  const modelsForProvider = selectedProvider
    ? orderModels(models.filter((m) => m.providerId === selectedProvider))
    : [];

  const onProviderChange = (providerId: string) => {
    // Pick the first model for the chosen provider so the selection is always a
    // valid { providerId, model } pair. With allowance active that is the
    // provider's allowance model (allowance-first ordering supersedes the
    // first-priced pick); otherwise it is exactly today's first priced model.
    const [first] = orderModels(models.filter((m) => m.providerId === providerId));
    if (first) onChange(first);
  };

  const onModelChange = (model: string) => {
    if (selectedProvider) onChange({ providerId: selectedProvider, model });
  };

  return (
    <div
      data-testid="platform-model-picker"
      className="flex flex-wrap items-end gap-3 border-b p-3"
    >
      <div className="space-y-1">
        <Label htmlFor="platform-provider">Provider</Label>
        <select
          id="platform-provider"
          aria-label="Provider"
          value={selectedProvider ?? ''}
          disabled={disabled}
          onChange={(e) => onProviderChange(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="" disabled>
            Select a provider
          </option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="platform-model">Model</Label>
        <select
          id="platform-model"
          aria-label="Model"
          value={value?.model ?? ''}
          disabled={disabled || !selectedProvider}
          onChange={(e) => onModelChange(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="" disabled>
            Select a model
          </option>
          {modelsForProvider.map((m) => (
            <option key={m.model} value={m.model}>
              {/* REQ-8.9a: mark the allowance model, only while it is active. */}
              {allowanceActive && m.allowance === true
                ? `${m.model} — includes free monthly turns`
                : m.model}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
