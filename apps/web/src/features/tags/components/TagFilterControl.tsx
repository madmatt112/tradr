import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';

import { TAG_CATEGORIES, TAG_CATEGORY_LABELS, type TagWithCount } from '@tradr/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { TagChip, UnknownTagChip } from './TagChip';

/**
 * The tags filter beside the positions list's status tabs (design Component 12).
 *
 * A dropdown of the user's tags grouped by category; toggling a checkbox keeps
 * the menu open (`onSelect` preventDefault) and reports the new id array through
 * `onChange`. `PositionList` sorts that array and writes it to the URL — the sort
 * lives THERE, never here, so `a,b` and `b,a` collapse to one cache entry once
 * (REQ-3.6). Beside the trigger the active selection renders as removable chips;
 * a selected id the user no longer owns renders as an `UnknownTagChip` so a stale
 * filter can always be cleared (REQ-3.5).
 */
export function TagFilterControl({
  tags,
  selectedIds,
  onChange,
}: {
  tags: TagWithCount[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange([...next]);
  };

  const groups = TAG_CATEGORIES.map((category) => ({
    category,
    items: tags.filter((tag) => tag.category === category),
  })).filter((group) => group.items.length > 0);

  const knownIds = new Set(tags.map((tag) => tag.id));
  const selectedTags = tags.filter((tag) => selected.has(tag.id));
  const unknownIds = selectedIds.filter((id) => !knownIds.has(id));

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="cursor-pointer">
            Tags
            {selectedIds.length > 0 && <Badge variant="secondary">{selectedIds.length}</Badge>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {tags.length === 0 ? (
            <>
              <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
              <DropdownMenuItem asChild className="cursor-pointer">
                {/* `/settings/tags` is registered by the Settings Tags tab
                    (design Component 15); the cast keeps this typed against the
                    router until that route exists. */}
                <Link to={'/settings/tags' as never}>Manage tags in Settings</Link>
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {groups.map((group, index) => (
                <Fragment key={group.category}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{TAG_CATEGORY_LABELS[group.category]}</DropdownMenuLabel>
                    {group.items.map((tag) => (
                      <DropdownMenuCheckboxItem
                        key={tag.id}
                        checked={selected.has(tag.id)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={() => toggle(tag.id)}
                        className="cursor-pointer"
                      >
                        {tag.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                </Fragment>
              ))}
              {selectedIds.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="cursor-pointer" onSelect={() => onChange([])}>
                    Clear filter
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedTags.map((tag) => (
        <TagChip key={tag.id} tag={tag} onRemove={() => toggle(tag.id)} />
      ))}
      {unknownIds.map((id) => (
        <UnknownTagChip
          key={id}
          id={id}
          onRemove={(removed) => onChange(selectedIds.filter((current) => current !== removed))}
        />
      ))}
    </div>
  );
}
