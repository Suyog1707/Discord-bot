import { ExternalLink, Server } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import { AppLink } from '@/components/navigation/app-link';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { guildIconUrl } from '@/lib/discord/cdn';
import { getEnv } from '@/lib/env';
import { listServers } from '@/lib/services/guilds';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Servers' };
export const dynamic = 'force-dynamic';

function inviteUrl(guildId: string): string {
  const clientId = getEnv().DISCORD_CLIENT_ID;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    // Connect, Speak, Send Messages, Embed Links, Read History, View Channels
    permissions: '277083450688',
    guild_id: guildId,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export default async function ServersPage() {
  const user = await requireUserOrRedirect('/dashboard/servers');
  const servers = await listServers(user.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
        <p className="text-muted-foreground">
          Servers where you have Manage Server permission. Invite the bot to control music there.
        </p>
      </div>

      {servers.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            No manageable servers found. You need the Manage Server permission on a server to see it
            here.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => {
            const icon = guildIconUrl({ id: server.discordId, icon: server.icon });
            return (
              <Card key={server.discordId} className="gap-4">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    {icon !== null ? (
                      <Image src={icon} alt="" width={40} height={40} className="rounded-lg" />
                    ) : (
                      <span className="bg-secondary flex size-10 items-center justify-center rounded-lg">
                        <Server aria-hidden className="text-muted-foreground size-5" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <CardTitle className="truncate">{server.name}</CardTitle>
                      <div className="mt-1 flex gap-1.5">
                        {server.owner && <Badge variant="secondary">Owner</Badge>}
                        {server.botPresent ? (
                          <Badge variant="success">Bot active</Badge>
                        ) : (
                          <Badge variant="outline">Bot not added</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {server.botPresent ? (
                    <Button asChild className="w-full">
                      <AppLink href={`/dashboard/servers/${server.discordId}`}>Manage</AppLink>
                    </Button>
                  ) : (
                    <Button asChild variant="outline" className="w-full">
                      <a
                        href={inviteUrl(server.discordId)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <ExternalLink aria-hidden /> Invite bot
                      </a>
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
