import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { TagFilterControl } from '@/features/tags/components/TagFilterControl';
import { useTags } from '@/features/tags/hooks/useTags';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { captureClientEvent } from '@/lib/telemetry/posthog';
import { useDrawerStore } from '@/stores/drawer.store';

import { usePositions } from '../hooks/usePositions';
import { isGroupEntry } from '../utils/listEntries';
import { buildListFilters } from '../utils/listFilters';

import { ClassificationFilter } from './ClassificationFilter';
import { CreatePositionDialog } from './CreatePositionDialog';
import { PositionGroupRows } from './PositionGroupRows';
import { PositionTableRow } from './PositionTableRow';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
] as const;

export function PositionList() {
  // The list filters live in the URL so a filtered view is shareable and
  // reload-safe (REQ-3.3). `buildListFilters` returns `undefined` for the empty
  // view, which keys `['positions', 'list', undefined]` — the same key the
  // no-filter call has always used.
  const search = useSearch({ from: '/_auth/positions/' });
  const navigate = useNavigate();
  const filters = buildListFilters(search);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: accounts } = useAccounts();
  const { data: entries, isLoading } = usePositions(filters);
  const tagsQuery = useTags();
  const selectedTagIds = filters?.tag ?? [];
  const inspectPosition = useDrawerStore((s) => s.inspectPosition);
  const inspectedId = useDrawerStore((s) => s.inspectedPosition?.id ?? null);
  // The browse/inspect two-state: while the drawer is open the wide columns
  // (Account, Entry, Exit, Fees, Age) yield so the table fits beside it — ONE
  // state change drives both the drawer and the columns, so the width settles
  // in a single reflow, and the drawer's own transition already honours
  // reduced motion.
  const drawerOpen = useDrawerStore((s) => s.isOpen);
  // Below 768 px a row click opens the full detail page, not the inspect drawer
  // (design D12): the phone drawer is a full-screen overlay that only duplicates
  // that page. jsdom's matchMedia stub returns false, so desktop keeps inspect.
  const isPhone = useMediaQuery('(max-width: 767px)');

  const hasAccounts = !!accounts?.length;

  // Fire a single deliberate product event on the dialog open transition (REQ-3.8,
  // design Component 9). No-op when PostHog is unconfigured. Routed through here so
  // it fires once per open, regardless of whether the open came from the button or
  // the dialog's own onOpenChange.
  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      captureClientEvent('position_create_dialog_opened');
    }
    setDialogOpen(open);
  };

  return (
    <>
      <PageHeader
        page="Positions"
        right={
          hasAccounts ? (
            // `data-tour` is the walkthrough's anchor for the log-a-position
            // step. Only on the enabled branch: a tour that reached this step has
            // an account, and highlighting a disabled button would be a dead end.
            <Button
              data-tour="position-new"
              className="cursor-pointer"
              onClick={() => handleDialogOpenChange(true)}
            >
              New Position
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button className="cursor-pointer" disabled>
                    New Position
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Create an account first</TooltipContent>
            </Tooltip>
          )
        }
      />

      <div className="mb-4 flex items-center gap-3 max-md:flex-wrap">
        <Tabs
          value={search.status ?? 'all'}
          onValueChange={(value) =>
            navigate({
              to: '/positions',
              search: (prev) => ({
                ...prev,
                status: value === 'all' ? undefined : (value as 'draft' | 'open' | 'closed'),
              }),
            })
          }
        >
          <TabsList>
            {STATUS_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="cursor-pointer">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <TagFilterControl
          tags={tagsQuery.data ?? []}
          selectedIds={selectedTagIds}
          onChange={(ids) =>
            navigate({
              to: '/positions',
              search: (prev) => ({ ...prev, tag: [...ids].sort().join(',') || undefined }),
            })
          }
        />
        <ClassificationFilter value={search.classification ?? 'all'} />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !entries?.length ? (
        filters === undefined ? (
          <EmptyState
            title="No positions yet"
            description="Log your first position to see it here."
          />
        ) : (
          <EmptyState
            title="No positions match this filter"
            action={
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() =>
                  navigate({
                    to: '/positions',
                    search: { status: undefined, tag: undefined, classification: undefined },
                  })
                }
              >
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow className="border-hairline">
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Status</TableHead>
              {!drawerOpen && <TableHead className="hidden md:table-cell">Tags</TableHead>}
              {!drawerOpen && <TableHead className="max-md:hidden">Account</TableHead>}
              <TableHead className="text-right max-md:hidden">Qty</TableHead>
              {!drawerOpen && <TableHead className="text-right max-md:hidden">Entry</TableHead>}
              {!drawerOpen && <TableHead className="text-right max-md:hidden">Exit</TableHead>}
              <TableHead className="text-right">P&L</TableHead>
              <TableHead className="text-right max-md:hidden">R</TableHead>
              {!drawerOpen && <TableHead className="text-right max-md:hidden">Fees</TableHead>}
              {!drawerOpen && <TableHead className="text-right max-md:hidden">Age</TableHead>}
              <TableHead className="w-10 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) =>
              isGroupEntry(entry) ? (
                <PositionGroupRows
                  key={entry.id}
                  group={entry}
                  drawerOpen={drawerOpen}
                  isPhone={isPhone}
                  inspectedId={inspectedId}
                  onInspect={inspectPosition}
                  onNavigate={(positionId) =>
                    navigate({ to: '/positions/$positionId', params: { positionId } })
                  }
                />
              ) : (
                <PositionTableRow
                  key={entry.id}
                  pos={entry}
                  drawerOpen={drawerOpen}
                  selected={entry.id === inspectedId}
                  isPhone={isPhone}
                  onInspect={inspectPosition}
                  onNavigate={(positionId) =>
                    navigate({ to: '/positions/$positionId', params: { positionId } })
                  }
                />
              ),
            )}
          </TableBody>
        </Table>
      )}

      <CreatePositionDialog open={dialogOpen} onOpenChange={handleDialogOpenChange} />
    </>
  );
}
