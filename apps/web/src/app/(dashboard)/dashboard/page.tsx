import type { Metadata } from 'next';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Overview' };

export default async function DashboardOverviewPage() {
  const user = await requireUserOrRedirect('/dashboard');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {user.username}</h1>
        <p className="text-muted-foreground">
          Manage your servers, control playback and curate playlists.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>Servers you manage where the bot is active.</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Populated once the bot phase is deployed.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Now playing</CardTitle>
            <CardDescription>Live playback across your servers.</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">Nothing playing yet.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Playlists</CardTitle>
            <CardDescription>Your saved playlists.</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">No playlists yet.</CardContent>
        </Card>
      </div>
    </div>
  );
}
