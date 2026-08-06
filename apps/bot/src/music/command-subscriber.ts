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
import type { MusicManager } from './music-manager.js';

const logger = getLogger('player-commands');

export class PlayerCommandSubscriber {
  readonly #subscriber: Redis;
  readonly #music: MusicManager;

  constructor(redisUrl: string, music: MusicManager) {
    this.#subscriber = createRedisClient({ url: redisUrl, logger });
    this.#music = music;
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
    const player = this.#music.getPlayer(command.guildId);
    if (player === undefined) {
      logger.debug({ command }, 'Command for guild without an active player; ignored');
      return;
    }

    logger.info(
      { guildId: command.guildId, action: command.action, issuedBy: command.issuedBy },
      'Applying dashboard command',
    );

    switch (command.action) {
      case 'pause':
        await player.pause();
        return;
      case 'resume':
        await player.resume();
        return;
      case 'skip':
        await player.skip();
        return;
      case 'stop':
        await player.stop();
        return;
      case 'volume':
        await player.setVolume(command.volume);
        return;
      case 'shuffle':
        player.shuffle();
        return;
    }
  }
}
