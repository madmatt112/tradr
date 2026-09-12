import { STARTER_TAGS, TAG_CATEGORY_LABELS } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { useAnswerStarterOffer } from '../hooks/useTags';
import { groupTagsByCategory } from '../utils/starterOffer';

import { TagChip } from './TagChip';

/**
 * The starter-set offer card (design Component 14; REQ-6.1/6.2). The sixteen
 * starter names render as neutral chips grouped by category, with **Add the
 * starter set** (`accept`) and **Start from scratch** (`decline`). It reads no
 * data beyond the mutation hook — the caller decides visibility with
 * `starterOfferState`, so the prominent offer appears at most once per user.
 */
export function StarterTagsOffer({ variant }: { variant: 'settings' | 'picker' }) {
  const answer = useAnswerStarterOffer();
  const groups = groupTagsByCategory(STARTER_TAGS);
  return (
    <Card data-slot="starter-tags-offer" data-variant={variant}>
      <CardHeader>
        <CardTitle>Start with a set of tags?</CardTitle>
        <CardDescription>
          Sixteen common setups, emotions and mistakes. You can rename or delete any of them later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.category} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              {TAG_CATEGORY_LABELS[group.category]}
            </h3>
            <div className="flex flex-wrap gap-1">
              {group.tags.map((tag) => (
                // Neutral, uncoloured chip; the synthetic id is the name (these
                // are constants, not persisted rows).
                <TagChip
                  key={tag.name}
                  tag={{ id: tag.name, name: tag.name, category: tag.category, color: null }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            className="cursor-pointer"
            disabled={answer.isPending}
            onClick={() => answer.mutate('accept')}
          >
            Add the starter set
          </Button>
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={answer.isPending}
            onClick={() => answer.mutate('decline')}
          >
            Start from scratch
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
