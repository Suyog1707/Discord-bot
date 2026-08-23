import { History } from 'lucide-react';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import {
  clearHistory,
  countHistory,
  listHistory,
  removeHistoryEntry,
} from '@/lib/services/history';
import { formatDuration } from '@/lib/utils';
import { ClearHistoryButton } from '@/components/dashboard/clear-history-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'History' };
export const dynamic = 'force-dynamic';

const PATH = '/dashboard/history';

/** Same-day plays show a clock, older ones a date — the usual "when" at a glance. */
function formatPlayedAt(playedAt: Date): string {
  const now = new Date();
  const sameDay =
    playedAt.getFullYear() === now.getFullYear() &&
    playedAt.getMonth() === now.getMonth() &&
    playedAt.getDate() === now.getDate();

  return sameDay
    ? playedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : playedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default async function HistoryPage() {
  const user = await requireUserOrRedirect(PATH);
  const [history, total] = await Promise.all([listHistory(user.id), countHistory(user.id)]);
  // The list is capped, and a cap nobody is told about reads as "this is all of
  // it" — which would make the count above quietly wrong for a heavy listener.
  const truncated = total > history.length;

  async function removeOne(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(PATH);
    const historyId = formData.get('historyId');
    if (typeof historyId === 'string' && historyId !== '') {
      await removeHistoryEntry(actor.id, historyId);
    }
    revalidatePath(PATH);
  }

  async function removeAll() {
    'use server';
    const actor = await requireUserOrRedirect(PATH);
    await clearHistory(actor.id);
    revalidatePath(PATH);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-muted-foreground">
          Tracks you actually listened to. A play is listed once more than half of it has been
          heard, so skips and tracks that failed to stream never show up here.
        </p>
      </div>

      {history.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History aria-hidden className="size-5" /> Nothing listened to yet
            </CardTitle>
            <CardDescription>
              Play something in Discord with <code className="font-mono">/play</code>. Once a track
              passes its halfway point it lands here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardDescription>
              {truncated
                ? `Newest ${String(history.length)} of ${String(total)} tracks listened to`
                : `${String(total)} track${total === 1 ? '' : 's'} listened to`}
            </CardDescription>
            <ClearHistoryButton action={removeAll} count={total} />
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-1">
              {history.map((entry, index) => (
                <li
                  key={entry.id}
                  className="hover:bg-accent/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
                    {String(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {entry.uri !== null ? (
                        <a
                          href={entry.uri}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:underline"
                        >
                          {entry.title}
                        </a>
                      ) : (
                        entry.title
                      )}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {entry.author}
                    </span>
                  </span>
                  <span
                    className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
                    title={entry.playedAt.toISOString()}
                  >
                    {formatPlayedAt(entry.playedAt)}
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-xs">
                    {formatDuration(entry.durationMs)}
                  </span>
                  <form action={removeOne}>
                    <input type="hidden" name="historyId" value={entry.id} />
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
