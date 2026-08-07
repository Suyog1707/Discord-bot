import { FolderOpen, ListMusic } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { formString } from '@/lib/forms';
import {
  createPlaylist,
  deletePlaylist,
  duplicatePlaylist,
  importPlaylist,
  listPlaylists,
} from '@/lib/services/playlists';
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

  // Group by folder; unfiled playlists render first without a heading.
  const folders = [...new Set(playlists.map((playlist) => playlist.folder))]
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map((folder) => [folder, playlists.filter((playlist) => playlist.folder === folder)] as const);

  async function create(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/playlists');
    await createPlaylist(actor.id, {
      name: formString(formData, 'name'),
      description: formString(formData, 'description') || undefined,
      folder: formString(formData, 'folder').trim() || undefined,
    });
    revalidatePath('/dashboard/playlists');
  }

  async function duplicate(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/playlists');
    await duplicatePlaylist(actor.id, formString(formData, 'playlistId'));
    revalidatePath('/dashboard/playlists');
  }

  async function importFromFile(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/playlists');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0 || file.size > 5_000_000) return;
    // importPlaylist validates the document; malformed JSON becomes a
    // ValidationError through the same parse path as the API route.
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      return;
    }
    await importPlaylist(actor.id, document);
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
            <div className="grid min-w-40 flex-1 gap-2">
              <Label htmlFor="folder">Folder (optional)</Label>
              <Input id="folder" name="folder" maxLength={100} placeholder="e.g. Chill" />
            </div>
            <Button type="submit">Create</Button>
          </form>
          <form
            action={importFromFile}
            className="border-border mt-4 flex flex-wrap items-end gap-3 border-t pt-4"
          >
            <div className="grid min-w-64 flex-1 gap-2">
              <Label htmlFor="file">Import a playlist (.json export)</Label>
              <Input id="file" name="file" type="file" accept="application/json,.json" required />
            </div>
            <Button type="submit" variant="secondary">
              Import
            </Button>
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
        folders.map(([folder, group]) => (
          <section key={folder ?? '(none)'} className="flex flex-col gap-3">
            {folder !== null && (
              <h2 className="text-muted-foreground flex items-center gap-2 text-sm font-semibold">
                <FolderOpen aria-hidden className="size-4" /> {folder}
              </h2>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.map((playlist) => (
                <Card key={playlist.id} className="gap-3">
                  <CardHeader>
                    <CardTitle className="truncate">{playlist.name}</CardTitle>
                    {playlist.description !== null && (
                      <CardDescription className="line-clamp-2">
                        {playlist.description}
                      </CardDescription>
                    )}
                    <div className="flex gap-1.5 pt-1">
                      <Badge variant="secondary">
                        {String(playlist.trackCount)} track{playlist.trackCount === 1 ? '' : 's'}
                      </Badge>
                      <Badge variant="outline">{playlist.visibility.toLowerCase()}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button asChild size="sm" className="flex-1">
                      <Link href={`/dashboard/playlists/${playlist.id}`}>Open</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/playlist/${playlist.id}/export`} download>
                        Export
                      </a>
                    </Button>
                    <form action={duplicate}>
                      <input type="hidden" name="playlistId" value={playlist.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Duplicate
                      </Button>
                    </form>
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
          </section>
        ))
      )}
    </div>
  );
}
