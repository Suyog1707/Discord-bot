import { Heart } from 'lucide-react';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { listFavorites, removeFavorite } from '@/lib/services/favorites';
import { formatDuration } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Favorites' };
export const dynamic = 'force-dynamic';

export default async function FavoritesPage() {
  const user = await requireUserOrRedirect('/dashboard/favorites');
  const favorites = await listFavorites(user.id);

  async function remove(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/favorites');
    const favoriteId = formData.get('favoriteId');
    if (typeof favoriteId === 'string' && favoriteId !== '') {
      await removeFavorite(actor.id, favoriteId);
    }
    revalidatePath('/dashboard/favorites');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Favorites</h1>
        <p className="text-muted-foreground">
          Tracks you saved with <code className="font-mono">/favorite add</code>. Queue them all in
          Discord with <code className="font-mono">/favorite play</code>.
        </p>
      </div>

      {favorites.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Heart aria-hidden className="size-5" /> Nothing saved yet
            </CardTitle>
            <CardDescription>
              While a track is playing, run <code className="font-mono">/favorite add</code> in
              Discord to keep it here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardDescription>
              {String(favorites.length)} saved track{favorites.length === 1 ? '' : 's'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-1">
              {favorites.map((favorite, index) => (
                <li
                  key={favorite.id}
                  className="hover:bg-accent/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-xs">
                    {String(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {favorite.uri !== null ? (
                        <a
                          href={favorite.uri}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:underline"
                        >
                          {favorite.title}
                        </a>
                      ) : (
                        favorite.title
                      )}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {favorite.author}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-xs">
                    {formatDuration(favorite.durationMs)}
                  </span>
                  <form action={remove}>
                    <input type="hidden" name="favoriteId" value={favorite.id} />
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
