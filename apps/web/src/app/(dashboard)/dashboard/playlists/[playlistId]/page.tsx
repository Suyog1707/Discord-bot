import { isAppError } from '@discord-music/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { formString } from '@/lib/forms';
import { getPlaylist, removeTrackFromPlaylist, updatePlaylist } from '@/lib/services/playlists';
import { formatDuration } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const metadata: Metadata = { title: 'Playlist' };
export const dynamic = 'force-dynamic';

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  const user = await requireUserOrRedirect(`/dashboard/playlists/${playlistId}`);

  let playlist: Awaited<ReturnType<typeof getPlaylist>>;
  try {
    playlist = await getPlaylist(user.id, playlistId);
  } catch (error) {
    if (isAppError(error) && error.statusCode === 404) notFound();
    throw error;
  }

  const totalMs = playlist.tracks.reduce(
    (total: number, track) => total + track.durationMs,
    0,
  );

  async function rename(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(`/dashboard/playlists/${playlistId}`);
    await updatePlaylist(actor.id, playlistId, { name: formString(formData, 'name') });
    revalidatePath(`/dashboard/playlists/${playlistId}`);
  }

  async function removeTrack(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(`/dashboard/playlists/${playlistId}`);
    await removeTrackFromPlaylist(actor.id, playlistId, formString(formData, 'trackId'));
    revalidatePath(`/dashboard/playlists/${playlistId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{playlist.name}</h1>
          <p className="text-muted-foreground">
            {String(playlist.trackCount)} tracks · {formatDuration(totalMs)} ·{' '}
            <Badge variant="outline" className="align-middle">
              {playlist.visibility.toLowerCase()}
            </Badge>
          </p>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/playlists">← All playlists</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rename</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={rename} className="flex items-end gap-3">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="name">Playlist name</Label>
              <Input id="name" name="name" defaultValue={playlist.name} required maxLength={100} />
            </div>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tracks</CardTitle>
        </CardHeader>
        <CardContent>
          {playlist.tracks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No tracks yet. Add the current queue from Discord with{' '}
              <code className="font-mono">/playlist save</code> (coming to the bot), or via the API.
            </p>
          ) : (
            <ol className="flex flex-col gap-1">
              {playlist.tracks.map((track) => (
                <li
                  key={track.id}
                  className="hover:bg-accent/40 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
                    {String(track.position + 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {track.uri !== null ? (
                        <a
                          href={track.uri}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:underline"
                        >
                          {track.title}
                        </a>
                      ) : (
                        track.title
                      )}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {track.author}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-xs">
                    {formatDuration(track.durationMs)}
                  </span>
                  <form action={removeTrack}>
                    <input type="hidden" name="trackId" value={track.id} />
                    <Button type="submit" size="sm" variant="ghost" className="text-destructive">
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
