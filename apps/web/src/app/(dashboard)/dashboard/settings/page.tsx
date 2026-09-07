import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { requireUserOrRedirect } from '@/lib/auth/session';
import {
  disconnectSpotify,
  getSpotifyStatus,
  setSpotifyAutoplayOptIn,
} from '@/lib/services/spotify';
import { isSpotifyConfigured } from '@/lib/spotify/client';
import { formString } from '@/lib/forms';
import {
  getProfile,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '@/lib/services/account';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

async function sessionTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  return (
    store.get('__Secure-authjs.session-token')?.value ??
    store.get('authjs.session-token')?.value ??
    null
  );
}

export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ spotify?: string }>;
}) {
  const user = await requireUserOrRedirect('/dashboard/settings');
  const [profile, sessions, spotify, params] = await Promise.all([
    getProfile(user.id),
    sessionTokenFromCookies().then((token) => listSessions(user.id, token)),
    getSpotifyStatus(user.id),
    searchParams,
  ]);
  const spotifyConfigured = isSpotifyConfigured();
  const spotifyOutcome = params.spotify;

  async function unlinkSpotify() {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await disconnectSpotify(actor.id);
    revalidatePath('/dashboard/settings');
  }

  async function toggleAutoplayOptIn(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await setSpotifyAutoplayOptIn(actor.id, formData.get('optIn') === 'on');
    revalidatePath('/dashboard/settings');
  }

  async function revokeOne(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await revokeSession(actor.id, formString(formData, 'sessionId'));
    revalidatePath('/dashboard/settings');
  }

  async function revokeOthers() {
    'use server';
    const actor = await requireUserOrRedirect('/dashboard/settings');
    await revokeOtherSessions(actor.id, await sessionTokenFromCookies());
    revalidatePath('/dashboard/settings');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
        <p className="text-muted-foreground">Your profile and active sessions.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Synced from Discord at each sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground text-xs">Username</p>
            <p className="font-medium">{profile.globalName ?? profile.username}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Email</p>
            <p className="font-medium">{profile.email ?? '—'}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Discord ID</p>
            <p className="font-mono text-xs">{profile.discordId}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Member since</p>
            <p className="font-medium">{profile.createdAt.toLocaleDateString()}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spotify</CardTitle>
          <CardDescription>
            Link your Spotify account to import playlists, albums and Liked Songs.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {spotifyOutcome === 'linked' && (
            <p className="text-success text-sm">Spotify account linked.</p>
          )}
          {(spotifyOutcome === 'denied' ||
            spotifyOutcome === 'invalid' ||
            spotifyOutcome === 'failed') && (
            <p role="alert" className="text-destructive text-sm">
              Spotify linking did not complete — try again.
            </p>
          )}
          {!spotifyConfigured ? (
            <p className="text-muted-foreground text-sm">
              Spotify integration is not configured on this deployment (SPOTIFY_CLIENT_ID /
              SPOTIFY_CLIENT_SECRET).
            </p>
          ) : spotify.linked ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 text-sm">
                <p className="font-medium">{spotify.displayName ?? spotify.spotifyId}</p>
                <p className="text-muted-foreground text-xs">
                  {spotify.country !== null ? `${spotify.country} · ` : ''}
                  scopes: {spotify.scopes.join(', ')}
                </p>
              </div>
              <form action={unlinkSpotify}>
                <Button type="submit" variant="destructive" size="sm">
                  Disconnect
                </Button>
              </form>

              <form action={toggleAutoplayOptIn} className="w-full">
                <Label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    name="optIn"
                    defaultChecked={spotify.autoplayOptIn}
                    className="mt-1 size-4"
                  />
                  <span className="text-sm">
                    Use my Spotify for autoplay
                    <span className="text-muted-foreground block text-xs">
                      Lets the bot treat your playlists and Liked Songs as music you already like,
                      and pick new songs in the same taste — but only in voice channels you are
                      actually sitting in. Turn this off to keep Spotify linked for playback alone.
                    </span>
                  </span>
                </Label>
                <Button type="submit" size="sm" variant="outline" className="mt-2">
                  Save preference
                </Button>
              </form>
            </div>
          ) : (
            <Button asChild size="sm" className="self-start">
              <a href="/api/spotify/authorize">Connect Spotify</a>
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Signed-in devices. Revoke anything you do not recognise.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="border-border flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {session.userAgent ?? 'Unknown device'}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {session.ipAddress ?? 'Unknown IP'} · signed in{' '}
                    {session.createdAt.toLocaleString()}
                  </span>
                </span>
                {session.current ? (
                  <Badge variant="success">This device</Badge>
                ) : (
                  <form action={revokeOne}>
                    <input type="hidden" name="sessionId" value={session.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Revoke
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          {sessions.some((session) => !session.current) && (
            <form action={revokeOthers}>
              <Button type="submit" variant="destructive" size="sm">
                Sign out all other devices
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
