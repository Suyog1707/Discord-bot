/**
 * Guild persistence.
 *
 * Single owner of the Guild + GuildSettings rows from the bot's side: events
 * and commands go through here rather than touching Prisma ad hoc, so the
 * "row exists with settings" invariant is maintained in exactly one place.
 * Queue rows belong to `QueueStore`, which keys them by voice channel.
 */
import type { Guild as DiscordGuild } from 'discord.js';

import type { GuildSettings, PrismaClient } from '@discord-music/database';
import { compareRoster } from '@discord-music/shared';

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

/**
 * How long the fleet roster and per-guild presence are cached.
 *
 * Both change only when an application is added to the deployment or a bot is
 * invited to a server — rare events, and both write paths invalidate what they
 * touch. Short anyway, so a stale answer costs one allocation rather than a
 * session.
 */
const ROSTER_CACHE_TTL_MS = 60_000;

export class GuildService {
  readonly #prisma: PrismaClient;
  readonly #settingsCache = new Map<string, { value: GuildSettings; expiresAt: number }>();
  /** In-flight reads, so concurrent callers share one query instead of racing. */
  readonly #settingsInFlight = new Map<string, Promise<GuildSettings>>();

  #rosterCache:
    { value: readonly { botId: string; clientId: string }[]; expiresAt: number } | undefined;

  readonly #presenceCache = new Map<string, { value: ReadonlySet<string>; expiresAt: number }>();

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Ensure a Guild row exists and is marked joined, with default settings.
   * Idempotent: safe on every `guildCreate` including rejoins.
   *
   * No queue row is created here any more. A queue belongs to a voice channel
   * now, and on join there is no channel to belong to — `QueueStore` creates
   * one the first time the bot actually plays somewhere.
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
      },
    });

    // Rejoins of guilds created before settings existed: fill the gap.
    const row = await this.#prisma.guild.findUniqueOrThrow({
      where: { discordId: guild.id },
      include: { settings: { select: { id: true } } },
    });
    if (row.settings === null) {
      await this.#prisma.guildSettings.create({ data: { guildId: row.id } });
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
   * Record that this deployment runs as a given Discord application.
   *
   * Written by every client at startup, including players that have never
   * joined a server — the dashboard needs the roster to offer an invite for
   * one, which is the whole point of having them.
   */
  async registerBot(bot: {
    readonly clientId: string;
    readonly label: string;
    readonly role: string;
  }): Promise<void> {
    try {
      await this.#prisma.playerBot.upsert({
        where: { clientId: bot.clientId },
        update: { label: bot.label, role: bot.role, lastSeenAt: new Date() },
        create: { ...bot, lastSeenAt: new Date() },
      });
    } catch (error) {
      // The roster is for the dashboard's benefit; failing to write it must
      // not stop a player from starting and holding a voice channel.
      logger.warn({ err: error, bot: bot.label }, 'Player roster write failed');
    }
  }

  /**
   * Record whether one player is in one guild.
   *
   * Separate from `Guild.isActive`, which stays a single flag meaning "this
   * server has the bot people talk to". A server may have added two players
   * and not the other five, and only a row per player can say so.
   */
  async setBotPresence(
    discordGuildId: string,
    botClientId: string,
    present: boolean,
  ): Promise<void> {
    try {
      const guild = await this.#prisma.guild.findUnique({
        where: { discordId: discordGuildId },
        select: { id: true },
      });
      // A player can be in a server the primary has never seen; there is no
      // guild row to hang presence off yet, and the primary's own join will
      // create one.
      if (guild === null) return;

      const now = new Date();
      await this.#prisma.guildBot.upsert({
        where: { guildId_botClientId: { guildId: guild.id, botClientId } },
        update: present
          ? { present: true, joinedAt: now, leftAt: null }
          : { present: false, leftAt: now },
        create: {
          guildId: guild.id,
          botClientId,
          present,
          ...(present ? { joinedAt: now } : { leftAt: now }),
        },
      });
      // Allocation reads this to decide whether a server can be offered
      // another player; a cached "no" outliving the invite is the one stale
      // answer worth spending a map delete to avoid.
      this.#presenceCache.delete(discordGuildId);
    } catch (error) {
      logger.warn(
        { err: error, guildId: discordGuildId, botClientId, present },
        'Player presence write failed',
      );
    }
  }

  /**
   * Every identity this deployment has ever started, oldest first.
   *
   * Oldest first is the order players are handed out in, and it is stable: the
   * primary registered before any player did, and player-2 before player-3, so
   * a server that has added two bots has added the same two as everybody else.
   *
   * Cached briefly. It is read on the path of every `/play` that has to
   * allocate, and the answer changes only when a new application is added to
   * the deployment.
   */
  async listBots(): Promise<readonly { botId: string; clientId: string }[]> {
    const cached = this.#rosterCache;
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;

    try {
      const rows = await this.#prisma.playerBot.findMany({
        select: { label: true, clientId: true, role: true },
      });
      // The router's order, so the bot and the router hand out players alike.
      const value = rows
        .map((row) => ({ botId: row.label, clientId: row.clientId, role: row.role }))
        .sort(compareRoster)
        .map(({ botId, clientId }) => ({ botId, clientId }));
      this.#rosterCache = { value, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS };
      return value;
    } catch (error) {
      logger.warn({ err: error }, 'Player roster read failed');
      // The caller's own identity is added by the router, so an empty roster
      // degrades to single-room behaviour rather than to no music at all.
      return cached?.value ?? [];
    }
  }

  /** Application ids of the players a server has actually added. */
  async botsInGuild(discordGuildId: string): Promise<ReadonlySet<string>> {
    const cached = this.#presenceCache.get(discordGuildId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;

    try {
      const rows = await this.#prisma.guildBot.findMany({
        where: { guild: { discordId: discordGuildId }, present: true },
        select: { botClientId: true },
      });
      const value = new Set(rows.map((row) => row.botClientId));
      this.#presenceCache.set(discordGuildId, {
        value,
        expiresAt: Date.now() + ROSTER_CACHE_TTL_MS,
      });
      return value;
    } catch (error) {
      logger.warn({ err: error, guildId: discordGuildId }, 'Player presence read failed');
      return cached?.value ?? new Set();
    }
  }

  /** Drop the cached presence for one guild — a bot just joined or left it. */
  invalidateBotsInGuild(discordGuildId: string): void {
    this.#presenceCache.delete(discordGuildId);
  }

  /**
   * Reconcile one player's presence against the servers it is actually in.
   *
   * `guildCreate` fires when a bot *joins*, not for servers it was already in
   * when the process started — so presence written only from that event would
   * stay empty for every existing server and the dashboard would offer an
   * invite for a player that is plainly already there. Run at startup, this
   * is also what repairs a row deleted by hand or missed while the bot was
   * offline.
   */
  async syncBotPresence(botClientId: string, discordGuildIds: readonly string[]): Promise<void> {
    try {
      const guilds = await this.#prisma.guild.findMany({
        where: { discordId: { in: [...discordGuildIds] } },
        select: { id: true },
      });
      const now = new Date();

      await Promise.all(
        guilds.map(async (guild) =>
          this.#prisma.guildBot.upsert({
            where: { guildId_botClientId: { guildId: guild.id, botClientId } },
            update: { present: true, joinedAt: now, leftAt: null },
            create: { guildId: guild.id, botClientId, present: true, joinedAt: now },
          }),
        ),
      );

      // Anything still marked present that this player is no longer in — it
      // was removed while the process was down, and nothing else will say so.
      const gone = await this.#prisma.guildBot.updateMany({
        where: { botClientId, present: true, guildId: { notIn: guilds.map((g) => g.id) } },
        data: { present: false, leftAt: now },
      });

      this.#presenceCache.clear();
      logger.info(
        { botClientId, present: guilds.length, cleared: gone.count },
        'Player presence reconciled',
      );
    } catch (error) {
      logger.warn({ err: error, botClientId }, 'Player presence reconcile failed');
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
        | 'djUserIds'
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
