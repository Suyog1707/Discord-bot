/**
 * Redis subscriber for dashboard-issued player commands.
 *
 * A dedicated connection is required: ioredis puts a connection into
 * subscriber mode, after which it cannot run regular commands. Started only
 * when both Redis and the music engine exist; without either, dashboard live
 * control simply stays unavailable.
 */
import {
  decodePlayerCommand,
  PLAYER_COMMAND_CHANNEL,
  type PlayerCommand,
} from '@discord-music/shared';
import { closeRedis, createRedisClient, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';
import { applyIntent } from './apply-intent.js';
import type { PlayerRouter } from './player-router.js';

const logger = getLogger('player-commands');

export class PlayerCommandSubscriber {
  readonly #subscriber: Redis;
  readonly #router: PlayerRouter;

  constructor(redisUrl: string, router: PlayerRouter) {
    this.#subscriber = createRedisClient({ url: redisUrl, logger });
    this.#router = router;
  }

  async start(): Promise<void> {
    await this.#subscriber.connect();
    await this.#subscriber.subscribe(PLAYER_COMMAND_CHANNEL);

    this.#subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== PLAYER_COMMAND_CHANNEL) return;

      const command = decodePlayerCommand(raw);
      if (command === null) {
        logger.warn({ raw: raw.slice(0, 200) }, 'Dropped malformed player command');
        return;
      }

      void this.#apply(command).catch((error: unknown) => {
        logger.error({ err: error, command }, 'Player command failed');
      });
    });

    logger.info('Subscribed to dashboard player commands');
  }

  async stop(): Promise<void> {
    await closeRedis(this.#subscriber);
  }

  async #apply(command: PlayerCommand): Promise<void> {
    // Commands name the room they are for, which is what stops a dashboard
    // open on one channel reaching into another.
    const room = this.#router.roomFor(command.guildId, command.voiceChannelId);
    if (room === undefined) {
      logger.debug({ command }, 'Command for a room with no active player; ignored');
      return;
    }

    logger.info(
      {
        guildId: command.guildId,
        voiceChannelId: command.voiceChannelId,
        action: command.action,
        issuedBy: command.issuedBy,
      },
      'Applying dashboard command',
    );

    /**
     * `sync-settings` is the dashboard's own shape — two optional booleans in
     * one message — and has no single-action equivalent, so it is unpacked
     * into the intents that do.
     */
    if (command.action === 'sync-settings') {
      if (command.stayConnected !== undefined) {
        await applyIntent(room, {
          action: 'stay-connected',
          guildId: command.guildId,
          voiceChannelId: command.voiceChannelId,
          issuedBy: command.issuedBy,
          enabled: command.stayConnected,
        });
      }
      if (command.autoplayEnabled !== undefined) {
        await applyIntent(room, {
          action: 'autoplay',
          guildId: command.guildId,
          voiceChannelId: command.voiceChannelId,
          issuedBy: command.issuedBy,
          enabled: command.autoplayEnabled,
        });
      }
      return;
    }

    // Every other dashboard command IS an intent, so it is applied through the
    // one implementation the HTTP surface and local commands also use.
    const result = await applyIntent(room, command);
    if (result.kind === 'error') {
      logger.warn({ command, reason: result.message }, 'Dashboard command was refused');
    }
  }
}
