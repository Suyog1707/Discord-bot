import { isAppError } from '@discord-music/shared';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect } from '@/lib/auth/session';
import { formNumber, formString } from '@/lib/forms';
import { guildIconUrl } from '@/lib/discord/cdn';
import { getServerDetail, updateGuildSettings } from '@/lib/services/guilds';
import { PlayerControls } from '@/components/dashboard/player-controls';
import { QueueList } from '@/components/dashboard/queue-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const metadata: Metadata = { title: 'Server' };
export const dynamic = 'force-dynamic';

export default async function ServerDetailPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const user = await requireUserOrRedirect(`/dashboard/servers/${guildId}`);

  let detail;
  try {
    detail = await getServerDetail(user.id, guildId);
  } catch (error) {
    // Not managed / bot absent → treat as a missing page rather than an error.
    if (isAppError(error) && (error.statusCode === 403 || error.statusCode === 404)) {
      notFound();
    }
    throw error;
  }

  const icon = guildIconUrl({ id: detail.discordId, icon: detail.icon });

  async function saveSettings(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(`/dashboard/servers/${guildId}`);

    const djRoleRaw = formString(formData, 'djRoleId').trim();
    await updateGuildSettings(actor.id, guildId, {
      defaultVolume: formNumber(formData, 'defaultVolume'),
      leaveOnEmptyAfter: formNumber(formData, 'leaveOnEmptyAfter'),
      announceNowPlaying: formData.get('announceNowPlaying') === 'on',
      stayConnected: formData.get('stayConnected') === 'on',
      autoplayEnabled: formData.get('autoplayEnabled') === 'on',
      djRoleId: djRoleRaw === '' ? null : djRoleRaw,
    });

    revalidatePath(`/dashboard/servers/${guildId}`);
    redirect(`/dashboard/servers/${guildId}?saved=1`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        {icon !== null && <Image src={icon} alt="" width={48} height={48} className="rounded-xl" />}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="success">Bot active</Badge>
            <Button variant="link" size="sm" asChild className="h-auto p-0">
              <Link href={`/dashboard/analytics?guild=${detail.discordId}`}>View analytics →</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Player</CardTitle>
            <CardDescription>
              Live queue and controls. Changes reach the bot within a moment.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PlayerControls
              guildId={detail.discordId}
              paused={detail.queue?.paused ?? false}
              volume={detail.queue?.volume ?? detail.settings.defaultVolume}
              loopMode={detail.queue?.loopMode ?? 'OFF'}
            />
            <QueueList
              guildId={detail.discordId}
              tracks={detail.queue?.tracks ?? []}
              currentIndex={detail.queue?.currentIndex ?? 0}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Defaults applied whenever the bot joins voice.</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Server-action form: no client JS needed for settings writes. */}
            <form action={saveSettings} className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="defaultVolume">Default volume (%)</Label>
                <Input
                  id="defaultVolume"
                  name="defaultVolume"
                  type="number"
                  min={0}
                  max={200}
                  defaultValue={detail.settings.defaultVolume}
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="leaveOnEmptyAfter">Auto-leave after (seconds)</Label>
                <Input
                  id="leaveOnEmptyAfter"
                  name="leaveOnEmptyAfter"
                  type="number"
                  min={60}
                  max={3600}
                  defaultValue={detail.settings.leaveOnEmptyAfter}
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="djRoleId">DJ role ID</Label>
                <Input
                  id="djRoleId"
                  name="djRoleId"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{17,20}"
                  placeholder="Leave empty to let everyone control music"
                  defaultValue={detail.settings.djRoleId ?? ''}
                />
                <p className="text-muted-foreground text-xs">
                  Right-click a role in Discord → Copy Role ID (developer mode required).
                </p>
              </div>

              <Label className="cursor-pointer">
                <input
                  type="checkbox"
                  name="announceNowPlaying"
                  defaultChecked={detail.settings.announceNowPlaying}
                  className="accent-primary size-4"
                />
                Announce now playing in the text channel
              </Label>

              <Label className="cursor-pointer">
                <input
                  type="checkbox"
                  name="stayConnected"
                  defaultChecked={detail.settings.stayConnected}
                  className="accent-primary size-4"
                />
                24/7 mode — stay in voice and rejoin after restarts
              </Label>

              <Label className="cursor-pointer">
                <input
                  type="checkbox"
                  name="autoplayEnabled"
                  defaultChecked={detail.settings.autoplayEnabled}
                  className="accent-primary size-4"
                />
                Smart autoplay — continue with similar tracks when the queue ends
              </Label>

              <Button type="submit" className="self-start">
                Save settings
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
