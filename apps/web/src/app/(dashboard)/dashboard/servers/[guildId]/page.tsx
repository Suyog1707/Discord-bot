import { identityOf } from '@discord-music/shared';
import { isAppError } from '@discord-music/shared';
import type { Metadata } from 'next';
import Image from 'next/image';
import { AppLink } from '@/components/navigation/app-link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireUserOrRedirect, withDiscordLink } from '@/lib/auth/session';
import { formNumber, formString } from '@/lib/forms';
import { guildIconUrl } from '@/lib/discord/cdn';
import { getServerDetail, updateGuildSettings, type ServerRoom } from '@/lib/services/guilds';
import { LivePlayer } from '@/components/dashboard/live-player';
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
    detail = await withDiscordLink(`/dashboard/servers/${guildId}`, () =>
      getServerDetail(user.id, guildId),
    );
  } catch (error) {
    // Not managed / bot absent → treat as a missing page rather than an error.
    if (isAppError(error) && (error.statusCode === 403 || error.statusCode === 404)) {
      notFound();
    }
    throw error;
  }

  const icon = guildIconUrl({ id: detail.discordId, icon: detail.icon });

  /**
   * One seed per room.
   *
   * Last persisted state seeds each live view; that room's SSE stream takes
   * over from its first event. Position is unknown between persists, so it
   * starts at 0.
   */
  const toSnapshotTrack = (track: ServerRoom['tracks'][number]) => ({
    // The persisted view has no identifier/source; position + URI are enough
    // to seed the display until the first live snapshot replaces everything.
    identifier: `persisted-${String(track.position)}`,
    title: track.title,
    author: track.author,
    durationMs: track.durationMs,
    uri: track.uri,
    artworkUrl: track.artworkUrl,
    isStream: track.isStream,
    source: 'queue',
    requestedByName: 'queue',
    // The canonical key the bot itself would use, so a "not like" pressed
    // before the first live snapshot arrives names the same song.
    trackKey: track.sourceKey ?? identityOf(track.author, track.title).key,
  });
  const seedFor = (room: ServerRoom) => {
    const current = room.tracks.find((track) => track.position === room.currentIndex) ?? null;
    if (current === null) return null;
    const upcoming = room.tracks.filter((track) => track.position > room.currentIndex);
    return {
      current: toSnapshotTrack(current),
      positionMs: 0,
      paused: room.paused,
      volume: room.volume,
      loopMode: room.loopMode.toLowerCase() as 'off' | 'track' | 'queue',
      autoplayEnabled: detail.settings.autoplayEnabled,
      stayConnected: detail.settings.stayConnected,
      activeFilter: null,
      voiceChannelId: room.voiceChannelId,
      upcoming: upcoming.slice(0, 100).map(toSnapshotTrack),
      upcomingTotal: upcoming.length,
    };
  };

  async function saveSettings(formData: FormData) {
    'use server';
    const actor = await requireUserOrRedirect(`/dashboard/servers/${guildId}`);

    const djRoleRaw = formString(formData, 'djRoleId').trim();
    // One textarea, one ID per line — `formString` reads a single value, so
    // the splitting happens here rather than with repeated form fields.
    const djUserIds = formString(formData, 'djUserIds')
      .split(/[\s,]+/u)
      .map((id) => id.trim())
      .filter((id) => id !== '');
    await updateGuildSettings(actor.id, guildId, {
      defaultVolume: formNumber(formData, 'defaultVolume'),
      leaveOnEmptyAfter: formNumber(formData, 'leaveOnEmptyAfter'),
      announceNowPlaying: formData.get('announceNowPlaying') === 'on',
      stayConnected: formData.get('stayConnected') === 'on',
      autoplayEnabled: formData.get('autoplayEnabled') === 'on',
      djRoleId: djRoleRaw === '' ? null : djRoleRaw,
      djUserIds,
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
              <AppLink href={`/dashboard/analytics?guild=${detail.discordId}`}>
                View analytics →
              </AppLink>
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {detail.rooms.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Player</CardTitle>
              <CardDescription>
                Nothing is playing here yet. Start something with <code>/play</code> in a voice
                channel.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          detail.rooms.map((room) => (
            <Card key={room.voiceChannelId}>
              <CardHeader>
                <CardTitle>Player</CardTitle>
                <CardDescription>
                  Voice channel <code>{room.voiceChannelId}</code>. Live queue and controls for this
                  room only — other channels in this server have their own.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <LivePlayer
                  guildId={detail.discordId}
                  voiceChannelId={room.voiceChannelId}
                  initial={seedFor(room)}
                />
              </CardContent>
            </Card>
          ))
        )}

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

              <div className="grid gap-2">
                <Label htmlFor="djUserIds">DJ user IDs</Label>
                <textarea
                  id="djUserIds"
                  name="djUserIds"
                  rows={3}
                  placeholder="One Discord user ID per line"
                  defaultValue={detail.settings.djUserIds.join('\n')}
                  className="border-input placeholder:text-muted-foreground focus-visible:ring-ring shadow-xs w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1"
                />
                <p className="text-muted-foreground text-xs">
                  Named DJs, for when you would rather not create a role. Like the DJ role, this
                  only applies while they are in the voice channel the bot is playing in — it is
                  never server-wide. Whoever starts the music always controls their own session and
                  can share it with <code>/dj add</code>.
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
