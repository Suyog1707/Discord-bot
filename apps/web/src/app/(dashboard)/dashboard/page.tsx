import type { Metadata } from 'next';
import Link from 'next/link';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { getProfile } from '@/lib/services/account';
import { listServers } from '@/lib/services/guilds';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function DashboardOverviewPage() {
  const user = await requireUserOrRedirect('/dashboard');

  const [profile, servers] = await Promise.all([
    getProfile(user.id),
    listServers(user.id).catch(() => []),
  ]);
  const activeServers = servers.filter((server) => server.botPresent);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {profile.globalName ?? profile.username}
        </h1>
        <p className="text-muted-foreground">
          Manage your servers, control playback and curate playlists.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Active servers</CardDescription>
            <CardTitle className="text-3xl">{String(activeServers.length)}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/servers">Manage servers</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Playlists</CardDescription>
            <CardTitle className="text-3xl">{String(profile.playlistCount)}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/playlists">Open playlists</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Plan</CardDescription>
            <CardTitle className="text-3xl">{profile.premium.tier}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/premium">View plans</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {activeServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Jump back in</CardTitle>
            <CardDescription>Your servers with the bot active.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {activeServers.slice(0, 6).map((server) => (
              <Button key={server.discordId} asChild size="sm" variant="secondary">
                <Link href={`/dashboard/servers/${server.discordId}`}>{server.name}</Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
