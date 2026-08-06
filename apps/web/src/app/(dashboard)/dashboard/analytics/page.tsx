import { isAppError } from '@discord-music/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { getGuildAnalytics } from '@/lib/services/analytics';
import { listServers } from '@/lib/services/guilds';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const user = await requireUserOrRedirect('/dashboard/analytics');
  const { guild: selectedGuildId } = await searchParams;

  const servers = (await listServers(user.id)).filter((server) => server.botPresent);
  const selected = servers.find((server) => server.discordId === selectedGuildId) ?? servers[0];

  let analytics = null;
  if (selected !== undefined) {
    try {
      analytics = await getGuildAnalytics(user.id, selected.discordId);
    } catch (error) {
      // Guild became unmanageable between listing and querying: show empty state.
      if (!isAppError(error)) throw error;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Listening activity over the last 30 days.</p>
      </div>

      {servers.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            Analytics appear once the bot is active in a server you manage.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {servers.map((server) => (
              <Button
                key={server.discordId}
                size="sm"
                variant={server.discordId === selected?.discordId ? 'default' : 'outline'}
                asChild
              >
                <Link href={`/dashboard/analytics?guild=${server.discordId}`}>{server.name}</Link>
              </Button>
            ))}
          </div>

          {analytics !== null && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardDescription>Total plays</CardDescription>
                    <CardTitle className="text-3xl">{String(analytics.totalPlays)}</CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>Top tracks charted</CardDescription>
                    <CardTitle className="text-3xl">{String(analytics.uniqueTracks)}</CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>Skip rate</CardDescription>
                    <CardTitle className="text-3xl">
                      {(analytics.skipRate * 100).toFixed(0)}%
                    </CardTitle>
                  </CardHeader>
                </Card>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Top tracks</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {analytics.topTracks.length === 0 ? (
                      <p className="text-muted-foreground text-sm">No plays recorded yet.</p>
                    ) : (
                      <ol className="flex flex-col gap-2">
                        {analytics.topTracks.map((track, index) => (
                          <li key={track.identifier} className="flex items-center gap-3 text-sm">
                            <span className="text-muted-foreground w-5 text-right font-mono text-xs">
                              {String(index + 1)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{track.title}</span>
                              <span className="text-muted-foreground block truncate text-xs">
                                {track.author}
                              </span>
                            </span>
                            <Badge variant="secondary">{String(track.plays)} plays</Badge>
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Recent plays</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {analytics.recentPlays.length === 0 ? (
                      <p className="text-muted-foreground text-sm">Nothing played recently.</p>
                    ) : (
                      <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
                        {analytics.recentPlays.map((play) => (
                          <li key={play.id} className="flex items-center gap-3 text-sm">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{play.title}</span>
                              <span className="text-muted-foreground block truncate text-xs">
                                {play.author} · {play.playedAt.toLocaleString()}
                              </span>
                            </span>
                            {play.skipped && <Badge variant="warning">skipped</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
