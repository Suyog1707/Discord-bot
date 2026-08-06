import { ListMusic } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { formString } from '@/lib/forms';
import { createPlaylist, deletePlaylist, listPlaylists } from '@/lib/services/playlists';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const metadata: Metadata = { title: 'Playlists' };
export const dynamic = 'force-dynamic';

export default async function PlaylistsPage() {
  const user = await requireUserOrRedirect('/dashboard/playlists');
  const playlists = await listPlaylists(user.id);

  async function create(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/playlists');
    await createPlaylist(actor.id, {
      name: formString(formData, 'name'),
      description: formString(formData, 'description') || undefined,
    });
    revalidatePath('/dashboard/playlists');
  }

  async function remove(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/playlists');
    await deletePlaylist(actor.id, formString(formData, 'playlistId'));
    revalidatePath('/dashboard/playlists');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playlists</h1>
        <p className="text-muted-foreground">
          Save queues you love and play them back with <code className="font-mono">/play</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New playlist</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={create} className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 flex-1 gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required maxLength={100} placeholder="Late night mix" />
            </div>
            <div className="grid min-w-64 flex-[2] gap-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Input id="description" name="description" maxLength={500} />
            </div>
            <Button type="submit">Create</Button>
          </form>
        </CardContent>
      </Card>

      {playlists.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <ListMusic aria-hidden className="size-8" />
            No playlists yet — create your first one above.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {playlists.map((playlist) => (
            <Card key={playlist.id} className="gap-3">
              <CardHeader>
                <CardTitle className="truncate">{playlist.name}</CardTitle>
                {playlist.description !== null && (
                  <CardDescription className="line-clamp-2">{playlist.description}</CardDescription>
                )}
                <div className="flex gap-1.5 pt-1">
                  <Badge variant="secondary">
                    {String(playlist.trackCount)} track{playlist.trackCount === 1 ? '' : 's'}
                  </Badge>
                  <Badge variant="outline">{playlist.visibility.toLowerCase()}</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Button asChild size="sm" className="flex-1">
                  <Link href={`/dashboard/playlists/${playlist.id}`}>Open</Link>
                </Button>
                <form action={remove}>
                  <input type="hidden" name="playlistId" value={playlist.id} />
                  <Button type="submit" size="sm" variant="destructive">
                    Delete
                  </Button>
                </form>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
