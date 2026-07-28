// ReleaseCard — one Card per release (REQ-4.2, 4.4, 4.8).

import type { ChangelogRelease } from '@tradr/shared';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { ReleaseMarkdown } from './ReleaseMarkdown';

// No absolute-date formatter exists in @/lib — format.ts exports
// formatRelativeTime / formatCurrency / formatMoney, all unsuitable for
// release dates — so format directly (design Component 9).
const releaseDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export interface ReleaseCardProps {
  release: ChangelogRelease;
}

export function ReleaseCard({ release }: ReleaseCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{release.name}</CardTitle>
        <CardDescription>{releaseDate.format(new Date(release.publishedAt))}</CardDescription>
        {release.prerelease && (
          <CardAction>
            <Badge variant="secondary">Pre-release</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <ReleaseMarkdown content={release.body} />
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-sm text-primary underline-offset-4 hover:underline cursor-pointer"
        >
          View on GitHub
        </a>
      </CardContent>
    </Card>
  );
}
