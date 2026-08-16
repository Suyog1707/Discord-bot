/**
 * Guild persistence.
 *
 * Single owner of the Guild + GuildSettings + Queue rows from the bot's side:
 * events and commands go through here rather than touching Prisma ad hoc, so
 * the "row exists with settings and queue" invariant is maintained in exactly
 * one place.
 */
import type { Guild as DiscordGuild } from 'discord.js';

import type { GuildSettings, PrismaClient } from '@discord-music/database';

import { getLogger } from '../lib/logger.js';

const logger = getLogger('guild-service');

/**
 * How long a settings read is reused before Postgres is consulted again.
 *
 * `/play` alone reads settings twice (the DJ guard, then player creation), and
 * every music command reads it at least once, so an uncached read puts a
 * database round-trip on the critical path of every interaction. The dashboard
 * writes settings too, so this is a TTL rather than a permanent cache: a change
 * made there takes effect within the window instead of instantly.
 */
const SETTINGS_CACHE_TTL_MS = 15_000;

export class GuildService {
  readonly #prisma: PrismaClient;
  readonly #settingsCache = new Map<string, { value: GuildSettings; expiresAt: number }>();
  /** In-flight reads, so concurrent callers share one query instead of racing. */
  readonly #settingsInFlight = new Map<string, Promise<GuildSettings>>();

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Ensure a Guild row exists and is marked joined, with default settings and
   * an empty queue. Idempotent: safe on every `guildCreate` including rejoins.
   */
  async ensureGuild(guild: DiscordGuild): Promise<void> {
    await this.#prisma.guild.upsert({
      where: { discordId: guild.id },
      update: {
        name: guild.name,
        icon: guild.icon,
        ownerId: guild.ownerId,
        botJoinedAt: new Date(),
        botLeftAt: null,
        isActive: true,
      },
      create: {
        discordId: guild.id,
        name: guild.name,
        icon: guild.icon,
        ownerId: guild.ownerId,
        botJoinedAt: new Date(),
        isActive: true,
        settings: { create: {} },
        queue: { create: {} },
      },
    });

    // Rejoins of guilds created before settings/queue existed: fill the gaps.
    const row = await this.#prisma.guild.findUniqueOrThrow({
      where: { discordId: guild.id },
      include: { settings: { select: { id: true } }, queue: { select: { id: true } } },
    });
    if (row.settings === null) {
      await this.#prisma.guildSettings.create({ data: { guildId: row.id } });
    }
    if (row.queue === null) {
      await this.#prisma.queue.create({ data: { guildId: row.id } });
    }

    this.invalidateSettings(guild.id);
    logger.info({ guildId: guild.id, name: guild.name }, 'Guild registered');
  }

  /**
   * Mark the bot as removed. The row is retained so settings and playlists
   * survive a re-invite (schema comment on Guild.botLeftAt).
   */
  async markGuildLeft(discordGuildId: string): Promise<void> {
    try {
      await this.#prisma.guild.update({
        where: { discordId: discordGuildId },
        data: {
          isActive: false,
          botLeftAt: new Date(),
        },
      });

      logger.info({ guildId: discordGuildId }, 'Guild marked inactive');
    } catch {
      logger.warn({ guildId: discordGuildId }, 'Guild left but no row existed');
    }
  }

  /**
   * Settings for a guild, creating the default row if it is missing.
   *
   * Served from a short-lived cache (see {@link SETTINGS_CACHE_TTL_MS}) so the
   * guard → player-creation path does not pay two database round-trips per
   * command. Bot-side writes invalidate the entry immediately.
   */
  async getSettings(discordGuildId: string): Promise<GuildSettings> {
    const cached = this.#settingsCache.get(discordGuildId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;

    const inFlight = this.#settingsInFlight.get(discordGuildId);
    if (inFlight !== undefined) return inFlight;

    const pending = this.#loadSettings(discordGuildId)
      .then((settings) => {
        this.#settingsCache.set(discordGuildId, {
          value: settings,
          expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
        });
        return settings;
      })
      .finally(() => {
        this.#settingsInFlight.delete(discordGuildId);
      });
    this.#settingsInFlight.set(discordGuildId, pending);
    return pending;
  }

  /** Drop the cached settings for a guild (after any write). */
  invalidateSettings(discordGuildId: string): void {
    this.#settingsCache.delete(discordGuildId);
  }

  /**
   * Settings for a path that must not block Discord's acknowledgement window.
   *
   * A known guild answers from cache immediately — even past the TTL, with the
   * refresh continuing in the background — because a slightly stale DJ role is
   * far better than an interaction invalidated by a slow database. A guild with
   * nothing cached races the read against `timeoutMs` and reports `null` if
   * Postgres did not answer in time, leaving the decision to the caller.
   */
  async getSettingsWithin(
    discordGuildId: string,
    timeoutMs: number,
  ): Promise<GuildSettings | null> {
    const cached = this.#settingsCache.get(discordGuildId);
    if (cached !== undefined) {
      if (cached.expiresAt <= Date.now()) {
        // Expired: serve the stale value now, refresh for the next caller.
        void this.getSettings(discordGuildId).catch((error: unknown) => {
          logger.warn(
            { err: error, guildId: discordGuildId },
            'Background settings refresh failed',
          );
        });
      }
      return cached.value;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.getSettings(discordGuildId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #loadSettings(discordGuildId: string): Promise<GuildSettings> {
    const guild = await this.#prisma.guild.findUnique({
      where: { discordId: discordGuildId },
      include: { settings: true },
    });

    if (guild === null) {
      // A command arrived before guildCreate persisted the row (or the bot was
      // added while offline). Create the minimum and return defaults.
      const created = await this.#prisma.guild.create({
        data: {
          discordId: discordGuildId,
          name: 'Unknown',
          botJoinedAt: new Date(),
          settings: { create: {} },
          queue: { create: {} },
        },
        include: { settings: true },
      });
      if (created.settings === null) {
        // Unreachable: the nested create above always writes the row.
        throw new Error('Guild settings missing immediately after creation.');
      }
      return created.settings;
    }

    if (guild.settings === null) {
      return this.#prisma.guildSettings.create({ data: { guildId: guild.id } });
    }

    return guild.settings;
  }

  /** Partial settings update keyed by Discord guild id. */
  async updateSettings(
    discordGuildId: string,
    data: Partial<
      Pick<
        GuildSettings,
        | 'defaultVolume'
        | 'djRoleId'
        | 'musicChannelId'
        | 'announceNowPlaying'
        | 'leaveOnEmptyAfter'
        | 'stayConnected'
        | 'autoplayEnabled'
      >
    >,
  ): Promise<GuildSettings> {
    // Ensure the row exists first so update cannot race a missing guild.
    const current = await this.getSettings(discordGuildId);
    const updated = await this.#prisma.guildSettings.update({ where: { id: current.id }, data });
    this.#settingsCache.set(discordGuildId, {
      value: updated,
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    });
    return updated;
  }
}
