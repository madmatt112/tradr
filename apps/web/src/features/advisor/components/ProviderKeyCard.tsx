// ProviderKeyCard — per-provider BYOK key surface (REQ-5 + REQ-7.4/7.6/7.8).
//
// Status is DERIVED, not persisted: the backend list returns only
// id/providerId/defaultModel/keyHintTail/lastUsedAt. We render:
//   - `unconfigured` when no list item exists for this provider;
//   - `verified` / `unverified` from the latest save (PUT) `verified` boolean;
//   - `rejected` when a save returns code PROVIDER_KEY_INVALID.
// On reload (no save outcome yet) a configured key shows the neutral
// "Configured" state with its keyHintTail.
//
// SECURITY: the plaintext key lives only in the controlled form field and is
// reset out of React state immediately after the save fires. It is never
// rendered back, logged, or cached.

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { type ProviderId, ProviderKeyInputSchema, type ProviderModel } from '@tradr/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  providerKeyKeys,
  useDeleteProviderKey,
  useProviderKeys,
  useSaveProviderKey,
  useUpdateDefaultModel,
} from '@/features/advisor/hooks/useProviderKeys';
import { api } from '@/lib/api';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

// Form-local schema: the wire schema makes defaultModel optional (the server
// picks the REQ-6.4 default on a first save — before a key exists there is no
// model list to choose from). The form keeps a plain string where '' means
// "let the server pick", so an empty selector never blocks the save.
const ProviderKeyFormSchema = ProviderKeyInputSchema.extend({
  defaultModel: z.string().max(64),
});
type ProviderKeyFormValues = z.infer<typeof ProviderKeyFormSchema>;

/** GET /advisor/models items arrive tagged with their owning provider. */
type ModelListItem = ProviderModel & { providerId: ProviderId };

type SaveOutcome = { kind: 'verified' } | { kind: 'unverified' } | { kind: 'rejected' };

type Status = 'unconfigured' | 'configured' | 'verified' | 'unverified' | 'rejected';

interface ApiErrorShape {
  status?: number;
  error?: { code?: string; message?: string };
}

function isProviderKeyRejected(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as ApiErrorShape;
  return e.error?.code === 'PROVIDER_KEY_INVALID';
}

export interface ProviderKeyCardProps {
  providerId: ProviderId;
}

export function ProviderKeyCard({ providerId }: ProviderKeyCardProps) {
  const { data: list } = useProviderKeys();
  const saveKey = useSaveProviderKey();
  const deleteKey = useDeleteProviderKey();
  const updateModel = useUpdateDefaultModel();

  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // GET /api/advisor/models — populates the default-model selector. No polling:
  // long stale time, no refetch interval. The list only covers providers with a
  // saved key, so it is empty until the first key is stored.
  const { data: models } = useQuery<{ items: ModelListItem[] }>({
    queryKey: providerKeyKeys.models(),
    queryFn: () => api.get<{ items: ModelListItem[] }>('/advisor/models'),
    staleTime: 10 * 60 * 1000,
  });

  const item = list?.items.find((i) => i.providerId === providerId) ?? null;
  const modelOptions = (models?.items ?? []).filter((m) => m.providerId === providerId);

  const status: Status = outcome ? outcome.kind : item ? 'configured' : 'unconfigured';

  const form = useForm<ProviderKeyFormValues>({
    resolver: zodResolver(ProviderKeyFormSchema),
    defaultValues: { apiKey: '', defaultModel: item?.defaultModel ?? '' },
  });

  // The list query resolves after first render; sync the saved default model
  // into the (controlled) selector once it arrives without clobbering the key.
  const itemDefaultModel = item?.defaultModel;
  useEffect(() => {
    if (itemDefaultModel) {
      form.setValue('defaultModel', itemDefaultModel);
    }
  }, [itemDefaultModel, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const result = await saveKey.mutateAsync({
        providerId,
        apiKey: values.apiKey,
        // '' = no selection (first save) — omit so the server picks the
        // REQ-6.4 default for this provider.
        defaultModel: values.defaultModel || undefined,
      });
      // Wipe the plaintext out of React state immediately after the save fires.
      form.reset({ apiKey: '', defaultModel: result.defaultModel });
      if (result.verified) {
        setOutcome({ kind: 'verified' });
        toast.success('Key verified');
      } else {
        setOutcome({ kind: 'unverified' });
        toast.warning(
          'Key saved but could not be verified — your provider may be temporarily unavailable.',
        );
      }
    } catch (err) {
      if (isProviderKeyRejected(err)) {
        setOutcome({ kind: 'rejected' });
        form.setValue('apiKey', '');
        toast.error(
          'API key rejected by provider. Check that the key is current and has not been revoked.',
        );
        return;
      }
      toast.error("Couldn't save key. Try again.");
    }
  });

  // Configured key: picking a model persists immediately via PATCH — no key
  // re-entry. Unconfigured: just stage the value for the upcoming first save.
  const onModelChange = (val: string) => {
    const previous = form.getValues('defaultModel');
    form.setValue('defaultModel', val);
    if (item && val && val !== previous) {
      updateModel.mutate(
        { providerId, defaultModel: val },
        {
          onSuccess: () => toast.success('Default model updated'),
          onError: () => {
            form.setValue('defaultModel', previous);
            toast.error("Couldn't update default model. Try again.");
          },
        },
      );
    }
  };

  const onDelete = async () => {
    try {
      await deleteKey.mutateAsync(providerId);
      setConfirmingDelete(false);
      setOutcome(null);
      form.reset({ apiKey: '', defaultModel: '' });
      toast.success('Key removed');
    } catch {
      toast.error("Couldn't remove key. Try again.");
    }
  };

  const label = PROVIDER_LABELS[providerId];

  return (
    <Card data-testid={`provider-key-card-${providerId}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{label}</CardTitle>
          {status === 'unconfigured' ? (
            <Badge variant="outline">Not configured</Badge>
          ) : (
            <Badge variant="secondary">Configured</Badge>
          )}
        </div>
        {item && <CardDescription>Key ••••••••{item.keyHintTail}</CardDescription>}
      </CardHeader>

      <CardContent className="space-y-4">
        {status === 'verified' && <p className="text-sm text-success">Key verified</p>}
        {status === 'unverified' && (
          <p className="text-sm text-warning">
            Key saved but could not be verified — your provider may be temporarily unavailable.
          </p>
        )}
        {status === 'rejected' && (
          <p className="text-sm text-destructive">
            API key rejected by provider. Check that the key is current and has not been revoked.
          </p>
        )}

        {status === 'unconfigured' && !form.formState.isSubmitted && outcome === null ? (
          <p className="text-sm text-muted-foreground">Add a {label} API key to start chatting.</p>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${providerId}-api-key`}>API key</Label>
            <Input
              id={`${providerId}-api-key`}
              type="password"
              autoComplete="off"
              placeholder="Paste your API key"
              {...form.register('apiKey')}
            />
            {form.formState.errors.apiKey && (
              <p className="text-sm text-destructive">{form.formState.errors.apiKey.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${providerId}-default-model`}>Default model</Label>
            <Select
              value={form.watch('defaultModel')}
              onValueChange={onModelChange}
              disabled={modelOptions.length === 0 || updateModel.isPending}
            >
              <SelectTrigger id={`${providerId}-default-model`} className="cursor-pointer">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Models become available once your key is saved — a default is picked for you and can
                be changed here afterwards.
              </p>
            )}
            {form.formState.errors.defaultModel && (
              <p className="text-sm text-destructive">
                {form.formState.errors.defaultModel.message}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" className="cursor-pointer" disabled={saveKey.isPending}>
              {saveKey.isPending ? 'Saving...' : 'Save key'}
            </Button>

            {item &&
              (confirmingDelete ? (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    className="cursor-pointer"
                    onClick={onDelete}
                    disabled={deleteKey.isPending}
                  >
                    Confirm remove
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Remove key
                </Button>
              ))}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
