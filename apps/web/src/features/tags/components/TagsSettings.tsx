import { useState } from 'react';

import { TAG_CATEGORY_LABELS, TAG_LIMITS, type TagColor, type TagWithCount } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOnboardingQuery } from '@/features/onboarding/hooks/useOnboarding';
import { cn } from '@/lib/utils';

import { useAnswerStarterOffer, useDeleteTag, useTags } from '../hooks/useTags';
import { groupTagsByCategory, starterOfferState } from '../utils/starterOffer';

import { DeleteTagDialog } from './DeleteTagDialog';
import { StarterTagsOffer } from './StarterTagsOffer';
import { TagChip } from './TagChip';
import { TagDialog } from './TagDialog';

// Static solid-fill class per swatch — Tailwind cannot build class names
// dynamically, so each token maps to a literal string it can see at build time.
const SWATCH_BG: Record<TagColor, string> = {
  'tag-1': 'bg-tag-1',
  'tag-2': 'bg-tag-2',
  'tag-3': 'bg-tag-3',
  'tag-4': 'bg-tag-4',
  'tag-5': 'bg-tag-5',
  'tag-6': 'bg-tag-6',
};

/**
 * The Settings **Tags** tab (design Component 15; REQ-5). The one place to see,
 * rename, recolour and delete tags, and the second surface of the once-only
 * starter offer. It reads the tags list and the cached onboarding answer, decides
 * which starter surface to show with `starterOfferState`, and drives create/edit
 * through `TagDialog` and delete through `DeleteTagDialog`.
 */
export function TagsSettings() {
  const { data: tags, isLoading, isError } = useTags();
  const { data: onboarding } = useOnboardingQuery();
  const answer = useAnswerStarterOffer();
  const deleteTag = useDeleteTag();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTag, setEditTag] = useState<TagWithCount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagWithCount | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-3" data-slot="tags-settings">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (isError || !tags) {
    return (
      <div className="py-8 text-center text-sm text-destructive" data-slot="tags-settings">
        Failed to load tags. Please try again.
      </div>
    );
  }

  const state = starterOfferState({ tags, onboarding });
  const atCap = tags.length >= TAG_LIMITS.perUser;
  const groups = groupTagsByCategory(tags);

  const openCreate = () => {
    setEditTag(null);
    setDialogOpen(true);
  };

  const newTagButton = (
    <Button className="cursor-pointer" onClick={openCreate}>
      New tag
    </Button>
  );

  return (
    <div className="space-y-6" data-slot="tags-settings">
      {state === 'offer' && <StarterTagsOffer variant="settings" />}

      <div className="flex flex-wrap items-center gap-2">
        {atCap ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button className="cursor-pointer" disabled onClick={openCreate}>
                  New tag
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>You have reached the limit of {TAG_LIMITS.perUser} tags</TooltipContent>
          </Tooltip>
        ) : (
          newTagButton
        )}

        {state === 'add-starter' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={answer.isPending}
                onClick={() => answer.mutate('accept')}
              >
                Add starter tags
              </Button>
            </TooltipTrigger>
            <TooltipContent>Adds any of the 16 starter tags you don&apos;t have</TooltipContent>
          </Tooltip>
        )}
      </div>

      {groups.length > 0 ? (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                {TAG_CATEGORY_LABELS[group.category]}
              </h3>
              <ul className="divide-y divide-hairline rounded-md border">
                {group.tags.map((tag) => (
                  <li key={tag.id} className="flex items-center gap-3 px-3 py-2">
                    <TagChip tag={tag} />
                    {tag.color ? (
                      <span
                        className={cn('size-3 shrink-0 rounded-full', SWATCH_BG[tag.color])}
                        aria-hidden
                      />
                    ) : (
                      <span
                        className="size-3 shrink-0 rounded-full border border-hairline"
                        aria-hidden
                      />
                    )}
                    <span className="text-sm text-muted-foreground">
                      {tag.positionCount} {tag.positionCount === 1 ? 'position' : 'positions'}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto cursor-pointer"
                          aria-label={`Actions for ${tag.name}`}
                        >
                          ⋯
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() => {
                            setEditTag(tag);
                            setDialogOpen(true);
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer text-destructive"
                          onClick={() => setDeleteTarget(tag)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : state !== 'offer' ? (
        <EmptyState title="No tags yet" action={newTagButton} />
      ) : null}

      <TagDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTag(null);
        }}
        tag={editTag}
      />

      {deleteTarget && (
        <DeleteTagDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          tag={deleteTarget}
          onConfirm={() => {
            deleteTag.mutate(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
