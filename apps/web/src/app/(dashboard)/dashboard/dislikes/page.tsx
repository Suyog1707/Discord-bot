import { ThumbsDown } from 'lucide-react';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { listDislikes, removeDislikeForUser } from '@/lib/services/dislikes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Not like' };
export const dynamic = 'force-dynamic';

const PATH = '/dashboard/dislikes';

/** Same-day rejections show a clock, older ones a date — as in History. */
function formatDislikedAt(createdAt: Date): string {
  const now = new Date();
  const sameDay =
    createdAt.getFullYear() === now.getFullYear() &&
    createdAt.getMonth() === now.getMonth() &&
    createdAt.getDate() === now.getDate();

  return sameDay
    ? createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : createdAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default async function DislikesPage() {
  const user = await requireUserOrRedirect(PATH);
  const dislikes = await listDislikes(user);

  async function remove(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(PATH);
    const trackKey = formData.get('trackKey');
    if (typeof trackKey === 'string' && trackKey !== '') {
      // No guild: undoing a dislike has no live effect worth chasing, and the
      // page has no player to speak to. The planner re-reads on its next pass.
      await removeDislikeForUser(actor, trackKey);
    }
    revalidatePath(PATH);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Not like</h1>
        <p className="text-muted-foreground">
          Songs you marked 👎 in Discord or here never come back through autoplay. Skips are not
          dislikes — a skip only nudges what gets suggested, this shuts a song out entirely.
        </p>
      </div>

      {dislikes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ThumbsDown aria-hidden className="size-5" /> Nothing rejected yet
            </CardTitle>
            <CardDescription>
              Songs you mark 👎 in Discord or here never come back through autoplay. Skips are not
              dislikes.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardDescription>
              {String(dislikes.length)} rejected track{dislikes.length === 1 ? '' : 's'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-1">
              {dislikes.map((dislike, index) => (
                <li
                  key={dislike.trackKey}
                  className="hover:bg-accent/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
                    {String(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{dislike.title}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {dislike.author}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {dislike.source}
                  </Badge>
                  <span
                    className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
                    title={dislike.createdAt.toISOString()}
                  >
                    {formatDislikedAt(dislike.createdAt)}
                  </span>
                  <form action={remove}>
                    <input type="hidden" name="trackKey" value={dislike.trackKey} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      className="text-destructive h-7 px-2 text-xs"
                    >
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
