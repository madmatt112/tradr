// ReleaseCard — one Card per release (REQ-4.2, 4.4, 4.8).
//
// Four tiers, each distinguished by more than size so they hold at small
// text: the version (mono, the app's face for identifiers and figures),
// the date meta (caption, muted), the `##` section eyebrows inside the body
// (ReleaseMarkdown), and the notes themselves. A rule under the header
// closes the identity block so the notes read as its content, and the
// GitHub link sits quietly in a footer instead of competing with the
// in-body links.

import { ExternalLink } from 'lucide-react';

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
      <CardHeader className="border-b">
        <CardTitle className="font-mono text-lg tracking-tight">{release.name}</CardTitle>
        <CardDescription className="text-xs">
          {releaseDate.format(new Date(release.publishedAt))}
        </CardDescription>
        {release.prerelease && (
          <CardAction>
            <Badge variant="secondary">Pre-release</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ReleaseMarkdown content={release.body} />
        <div className="mt-5 border-t border-border pt-4">
          <a
            href={release.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            View on GitHub
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
