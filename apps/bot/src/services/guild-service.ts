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

export class GuildService {
  readonly #prisma: PrismaClient;

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

      logger.info(
        { guildId: discordGuildId },
        'Guild marked inactive',
      );
    } catch {
      logger.warn(
        { guildId: discordGuildId },
        'Guild left but no row existed',
      );
    }
  }

  /** Settings for a guild, creating the default row if it is missing. */
  async getSettings(discordGuildId: string): Promise<GuildSettings> {
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
    return this.#prisma.guildSettings.update({ where: { id: current.id }, data });
  }
}
