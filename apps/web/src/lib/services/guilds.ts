import 'server-only';

/**
 * Guild data for the dashboard: server list, detail (settings + queue
 * snapshot), and settings updates. Authorization always goes through
 * `requireManagedGuild`; this module never re-implements permission checks.
 */
import { LIMITS, parseOrThrow, z } from '@discord-music/shared';
import type { GuildSettings } from '@discord-music/database';

import {
  encodePlayerCommand,
  PLAYER_COMMAND_CHANNEL,
  playerCommandSchema,
} from '@discord-music/shared';

import { requireManagedGuild } from '@/lib/authz';
import { getDb } from '@/lib/db';
import { fetchManageableGuilds } from '@/lib/discord/api';
import { omitUndefined } from '@/lib/object';
import { getRedis } from '@/lib/redis';

export interface ServerListEntry {
  readonly discordId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly owner: boolean;
  /** False → show an invite button instead of a manage link. */
  readonly botPresent: boolean;
}

/** Manageable guilds annotated with bot presence, bot-present first. */
export async function listServers(userId: string): Promise<readonly ServerListEntry[]> {
  const manageable = await fetchManageableGuilds(userId);
  if (manageable.length === 0) return [];

  const present = await getDb().guild.findMany({
    where: { discordId: { in: manageable.map((guild) => guild.id) }, isActive: true },
    select: { discordId: true },
  });
  const presentIds = new Set(present.map((row) => row.discordId));

  return manageable
    .map((guild) => ({
      discordId: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      botPresent: presentIds.has(guild.id),
    }))
    .sort((a, b) => Number(b.botPresent) - Number(a.botPresent) || a.name.localeCompare(b.name));
}

export interface QueueTrackView {
  readonly position: number;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly uri: string | null;
  readonly artworkUrl: string | null;
  readonly isStream: boolean;
  /**
   * Canonical key of the candidate an autoplay pick was chosen as, when the
   * bot recorded one. The initial player snapshot derives its `trackKey`
   * from this so a "not like" pressed before the first live event names the
   * same recording the recommender knows.
   */
  readonly sourceKey: string | null;
}

export interface ServerDetail {
  readonly discordId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly settings: Pick<
    GuildSettings,
    | 'defaultVolume'
    | 'djRoleId'
    | 'announceNowPlaying'
    | 'leaveOnEmptyAfter'
    | 'musicChannelId'
    | 'stayConnected'
    | 'autoplayEnabled'
  >;
  readonly queue: {
    readonly paused: boolean;
    readonly volume: number;
    readonly loopMode: string;
    readonly currentIndex: number;
    /** The voice channel this queue belongs to; each keeps its own. */
    readonly voiceChannelId: string;
    readonly tracks: readonly QueueTrackView[];
  } | null;
}

/** Settings + persisted queue snapshot for the server page. */
export async function getServerDetail(
  userId: string,
  discordGuildId: string,
): Promise<ServerDetail> {
  const { guild, summary } = await requireManagedGuild(userId, discordGuildId);
  const db = getDb();

  const [settings, queue] = await Promise.all([
    db.guildSettings.upsert({
      where: { guildId: guild.id },
      update: {},
      create: { guildId: guild.id },
    }),
    // A guild has one saved queue per voice channel now. The page shows the
    // room the bot was most recently in, which is the one a live player would
    // be serving; the others are waiting for somebody to start the bot there.
    db.queue.findFirst({
      where: { guildId: guild.id },
      orderBy: { updatedAt: 'desc' },
      include: { tracks: { orderBy: { position: 'asc' } } },
    }),
  ]);

  return {
    discordId: guild.discordId,
    name: summary.name,
    icon: summary.icon,
    settings: {
      defaultVolume: settings.defaultVolume,
      djRoleId: settings.djRoleId,
      announceNowPlaying: settings.announceNowPlaying,
      leaveOnEmptyAfter: settings.leaveOnEmptyAfter,
      musicChannelId: settings.musicChannelId,
      stayConnected: settings.stayConnected,
      autoplayEnabled: settings.autoplayEnabled,
    },
    queue:
      queue === null
        ? null
        : {
            paused: queue.paused,
            volume: queue.volume,
            loopMode: queue.loopMode.toLowerCase(),
            currentIndex: queue.currentIndex,
            voiceChannelId: queue.voiceChannelId,
            tracks: queue.tracks.map((track) => ({
              position: track.position,
              title: track.title,
              author: track.author,
              durationMs: track.durationMs,
              uri: track.uri,
              artworkUrl: track.artworkUrl,
              isStream: track.isStream,
              sourceKey: track.sourceKey,
            })),
          },
  };
}

export const updateGuildSettingsSchema = z
  .object({
    defaultVolume: z.number().int().min(LIMITS.VOLUME_MIN).max(LIMITS.VOLUME_MAX).optional(),
    djRoleId: z
      .string()
      .regex(/^\d{17,20}$/u, 'Must be a Discord role ID.')
      .nullable()
      .optional(),
    announceNowPlaying: z.boolean().optional(),
    leaveOnEmptyAfter: z.number().int().min(60).max(3600).optional(),
    stayConnected: z.boolean().optional(),
    autoplayEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one setting to change.');

export type UpdateGuildSettingsInput = z.input<typeof updateGuildSettingsSchema>;

export async function updateGuildSettings(
  userId: string,
  discordGuildId: string,
  input: unknown,
): Promise<ServerDetail['settings']> {
  const { guild } = await requireManagedGuild(userId, discordGuildId);
  const data = omitUndefined(parseOrThrow(updateGuildSettingsSchema, input));

  const settings = await getDb().guildSettings.upsert({
    where: { guildId: guild.id },
    update: data,
    create: { guildId: guild.id, ...data },
  });

  // Live players learn about 24/7 / autoplay changes immediately over the
  // command channel; without Redis they pick them up on the next join.
  if (data.stayConnected !== undefined || data.autoplayEnabled !== undefined) {
    const redis = getRedis();
    if (redis !== undefined) {
      const sync = playerCommandSchema.parse({
        action: 'sync-settings',
        guildId: discordGuildId,
        // System-issued on behalf of the guild manager; the guild snowflake
        // stands in because the authorizer is already recorded in the API log.
        issuedBy: discordGuildId,
        ...(data.stayConnected === undefined ? {} : { stayConnected: data.stayConnected }),
        ...(data.autoplayEnabled === undefined ? {} : { autoplayEnabled: data.autoplayEnabled }),
      });
      await redis.publish(PLAYER_COMMAND_CHANNEL, encodePlayerCommand(sync)).catch(() => 0);
    }
  }

  return {
    defaultVolume: settings.defaultVolume,
    djRoleId: settings.djRoleId,
    announceNowPlaying: settings.announceNowPlaying,
    leaveOnEmptyAfter: settings.leaveOnEmptyAfter,
    musicChannelId: settings.musicChannelId,
    stayConnected: settings.stayConnected,
    autoplayEnabled: settings.autoplayEnabled,
  };
}
