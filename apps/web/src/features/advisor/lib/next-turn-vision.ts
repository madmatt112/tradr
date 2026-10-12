// Whether the model the NEXT advisor message will run on accepts images.
//
// Mirrors the server's model resolution (loadStreamContext + stream.handler):
//  - an existing conversation runs on its pinned provider/model;
//  - a new conversation in platform-picker mode runs on the picked model;
//  - any other new conversation runs on the stored provider key's default model.
// The vision flag comes from the BYOK model list (GET /advisor/models) when the
// user has a key for that provider, else from the platform model list
// (GET /billing/config). Unknown models are treated as not vision-capable.

import type { BillingModel, ProviderId, ProviderModel } from '@tradr/shared';

export type ByokModel = ProviderModel & { providerId: ProviderId };

interface ModelRef {
  providerId: ProviderId;
  model: string;
}

export interface NextTurnVisionInput {
  /** The pinned provider/model of the open conversation; null on a new one. */
  conversation: ModelRef | null;
  /** True when the open conversation is an existing one. */
  existingConversation: boolean;
  /** True when the new-conversation platform model picker is shown. */
  showPlatformPicker: boolean;
  platformOverride: BillingModel | null;
  providerKeys: { providerId: ProviderId; defaultModel: string }[];
  byokModels: ByokModel[];
  platformModels: BillingModel[];
}

export function nextTurnVisionEnabled(input: NextTurnVisionInput): boolean {
  let target: ModelRef | null;
  if (input.existingConversation) {
    target = input.conversation;
  } else if (input.showPlatformPicker) {
    target = input.platformOverride;
  } else {
    const key = input.providerKeys[0];
    target = key ? { providerId: key.providerId, model: key.defaultModel } : null;
  }
  if (!target) return false;

  const { providerId, model } = target;
  if (input.providerKeys.some((k) => k.providerId === providerId)) {
    return (
      input.byokModels.find((m) => m.providerId === providerId && m.id === model)?.vision === true
    );
  }
  return (
    input.platformModels.find((m) => m.providerId === providerId && m.model === model)?.vision ===
    true
  );
}
