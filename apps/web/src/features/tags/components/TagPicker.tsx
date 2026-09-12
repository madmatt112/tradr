import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  TAG_CATEGORIES,
  TAG_CATEGORY_LABELS,
  TAG_LIMITS,
  TAG_NAME_MAX_LENGTH,
  TagNameSchema,
  type Tag,
  type TagCategory,
} from '@tradr/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useOnboardingQuery } from '@/features/onboarding/hooks/useOnboarding';

import { getTagErrorCode, useCreateTag, useSetPositionTags, useTags } from '../hooks/useTags';
import { starterOfferState } from '../utils/starterOffer';

import { StarterTagsOffer } from './StarterTagsOffer';
import { TagChip } from './TagChip';

// An inline-created tag before it is posted. `createdId` is filled in once the
// confirming `POST /api/tags` succeeds, so a `PUT` that then fails is not retried
// by re-creating the same name (which would 409) — the entry keeps its real id.
type PendingTag = { name: string; category: TagCategory; createdId?: string };

// The Set key for a pending entry: the real id once created, else a synthetic
// key. Names are unique (rejected case-insensitively on Add), so the key is too.
const pendingKey = (p: PendingTag): string => p.createdId ?? `pending:${p.name.toLowerCase()}`;

/** Text for the inline-create error slot, chosen by CODE, never by message. */
function createErrorText(code: string): string {
  switch (code) {
    case 'TAG_NAME_TAKEN':
      return 'A tag with this name already exists';
    case 'TAG_LIMIT_REACHED':
      return `You have reached the limit of ${TAG_LIMITS.perUser} tags`;
    case 'INVALID_NAME':
      return 'Enter a valid tag name';
    default:
      return 'Could not create the tag';
  }
}

/** Text for the save (`PUT`) error slot, chosen by CODE, never by message. The
 * shared `NOT_FOUND` is softened rather than split (tasks Decision 3). */
function saveErrorText(code: string): string {
  switch (code) {
    case 'TAG_LIMIT_REACHED':
      return `This position can carry at most ${TAG_LIMITS.perPosition} tags`;
    case 'NOT_FOUND':
      return 'This position or one of its tags was deleted in another tab — close and reopen to refresh';
    default:
      return 'Could not update tags';
  }
}

/**
 * Edit a position's tags without leaving the page (design Component 13; REQ-4).
 *
 * A grouped checkbox list seeded from `currentTags`, an inline create (name +
 * category) posted at confirm time before the single `PUT`, and — in the row-1
 * state (no tags, offer unanswered) — the starter offer in place of the list.
 * Errors render inline by code; the shared `PUT` `NOT_FOUND` is softened and
 * invalidates both caches so the parent page shows whichever resource went away.
 */
export function TagPicker({
  open,
  onOpenChange,
  positionId,
  currentTags,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionId: string;
  currentTags: Tag[];
}) {
  const queryClient = useQueryClient();
  const { data: tags = [] } = useTags();
  const { data: onboarding } = useOnboardingQuery();
  const setPositionTags = useSetPositionTags(positionId);
  const createTag = useCreateTag();

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentTags.map((t) => t.id)),
  );
  const [pending, setPending] = useState<PendingTag[]>([]);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [errorSlot, setErrorSlot] = useState<'create' | 'save'>('save');
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<TagCategory>('setup');

  // Re-seed each time the dialog (re)opens so a cancelled edit does not leak into
  // the next open. Deps are intentionally just `open`.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(currentTags.map((t) => t.id)));
    setPending([]);
    setErrorCode(undefined);
    setErrorSlot('save');
    setNewName('');
    setNewCategory('setup');
  }, [open]);

  const showOffer = starterOfferState({ tags, onboarding }) === 'offer';
  const atCap = selected.size >= TAG_LIMITS.perPosition;

  const currentIds = new Set(currentTags.map((t) => t.id));
  const unchanged =
    pending.length === 0 &&
    selected.size === currentIds.size &&
    [...selected].every((id) => currentIds.has(id));
  const saveDisabled = createTag.isPending || setPositionTags.isPending || unchanged;

  // A created-but-unattached tag reappears via the ['tags'] refetch, so drop it
  // from the pending rows to avoid rendering it twice.
  const tagIds = new Set(tags.map((t) => t.id));
  const visiblePending = pending.filter((p) => !(p.createdId && tagIds.has(p.createdId)));

  const groups = TAG_CATEGORIES.map((category) => ({
    category,
    rows: [
      ...tags
        .filter((t) => t.category === category)
        .map((t) => ({ key: t.id, tag: t as Tag, isNew: false })),
      ...visiblePending
        .filter((p) => p.category === category)
        .map((p) => ({
          key: pendingKey(p),
          tag: { id: pendingKey(p), name: p.name, category: p.category, color: null } as Tag,
          isNew: true,
        })),
    ],
  })).filter((group) => group.rows.length > 0);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAdd = () => {
    const parsed = TagNameSchema.safeParse(newName);
    if (!parsed.success) {
      setErrorSlot('create');
      setErrorCode('INVALID_NAME');
      return;
    }
    const name = parsed.data;
    const lower = name.toLowerCase();
    const clash =
      tags.some((t) => t.name.toLowerCase() === lower) ||
      pending.some((p) => p.name.toLowerCase() === lower);
    if (clash) {
      setErrorSlot('create');
      setErrorCode('TAG_NAME_TAKEN');
      return;
    }
    const entry: PendingTag = { name, category: newCategory };
    setPending((prev) => [...prev, entry]);
    setSelected((prev) => new Set(prev).add(pendingKey(entry)));
    setNewName('');
    setErrorCode(undefined);
  };

  const handleSave = async () => {
    setErrorCode(undefined);
    // Work on locals: state setters do not settle inside the loop, and the PUT
    // needs the real ids the POSTs return.
    const localSelected = new Set(selected);
    const localPending = [...pending];

    for (let i = 0; i < localPending.length; i++) {
      const p = localPending[i];
      if (p.createdId) continue; // created on a prior attempt — do not recreate
      const key = pendingKey(p);
      if (!localSelected.has(key)) continue; // unchecked before saving
      try {
        const created = await createTag.mutateAsync({ name: p.name, category: p.category });
        localSelected.delete(key);
        localSelected.add(created.id);
        localPending[i] = { ...p, createdId: created.id };
      } catch (err) {
        // TAG_NAME_TAKEN / TAG_LIMIT_REACHED stop the sequence and render inline
        // beside the create row; the tags created so far stay in the vocabulary.
        setPending(localPending);
        setSelected(localSelected);
        setErrorSlot('create');
        setErrorCode(getTagErrorCode(err) ?? 'CREATE_FAILED');
        return;
      }
    }

    try {
      await setPositionTags.mutateAsync([...localSelected]);
      onOpenChange(false);
    } catch (err) {
      const code = getTagErrorCode(err);
      if (code === 'NOT_FOUND') {
        // Softened, not split (Decision 3): show whichever resource went away by
        // refreshing both the tags list and this position's detail.
        queryClient.invalidateQueries({ queryKey: ['tags'] });
        queryClient.invalidateQueries({ queryKey: ['positions', 'detail', positionId] });
      }
      // Keep the selection open (including any newly created ids) so the user can retry.
      setPending(localPending);
      setSelected(localSelected);
      setErrorSlot('save');
      setErrorCode(code ?? 'SAVE_FAILED');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
        </DialogHeader>

        {showOffer ? (
          <StarterTagsOffer variant="picker" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
              {groups.length === 0 && (
                <p className="text-sm text-muted-foreground">You have no tags yet.</p>
              )}
              {groups.map((group) => (
                <div key={group.category} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {TAG_CATEGORY_LABELS[group.category]}
                  </h3>
                  {group.rows.map((row) => (
                    <Label key={row.key} className="cursor-pointer">
                      <Checkbox
                        aria-label={row.tag.name}
                        checked={selected.has(row.key)}
                        onCheckedChange={() => toggle(row.key)}
                      />
                      <TagChip tag={row.tag} />
                      {row.isNew && <Badge variant="outline">new</Badge>}
                    </Label>
                  ))}
                </div>
              ))}
            </div>

            {errorCode && errorSlot === 'save' && (
              <p className="text-sm text-destructive">{saveErrorText(errorCode)}</p>
            )}

            <div className="flex flex-col gap-2 border-t pt-4">
              <div className="flex items-end gap-2">
                <Input
                  aria-label="New tag"
                  placeholder="New tag"
                  maxLength={TAG_NAME_MAX_LENGTH}
                  value={newName}
                  disabled={atCap}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    if (errorSlot === 'create') setErrorCode(undefined);
                  }}
                />
                <Select
                  value={newCategory}
                  disabled={atCap}
                  onValueChange={(value) => setNewCategory(value as TagCategory)}
                >
                  <SelectTrigger aria-label="Category" className="cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAG_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category} className="cursor-pointer">
                        {TAG_CATEGORY_LABELS[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  className="cursor-pointer"
                  disabled={atCap}
                  onClick={handleAdd}
                >
                  Add
                </Button>
              </div>
              {atCap && (
                <p className="text-sm text-muted-foreground">
                  This position already has {TAG_LIMITS.perPosition} tags
                </p>
              )}
              {errorCode && errorSlot === 'create' && (
                <p className="text-sm text-destructive">{createErrorText(errorCode)}</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="cursor-pointer" disabled={saveDisabled} onClick={handleSave}>
            {createTag.isPending || setPositionTags.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
