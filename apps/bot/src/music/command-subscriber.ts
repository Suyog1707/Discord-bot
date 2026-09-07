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
  identityOf,
  PLAYER_COMMAND_CHANNEL,
  type PlayerCommand,
} from '@discord-music/shared';
import { closeRedis, createRedisClient, type Redis } from '@discord-music/shared/redis';

import { getLogger } from '../lib/logger.js';
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
    const player = room.player;

    logger.info(
      {
        guildId: command.guildId,
        voiceChannelId: command.voiceChannelId,
        action: command.action,
        issuedBy: command.issuedBy,
      },
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
      case 'previous':
        await player.previous();
        return;
      case 'jump':
        await player.jumpTo(player.queue.currentIndex + command.position);
        return;
      case 'remove':
        player.removeUpcoming(command.position - 1);
        return;
      case 'move':
        player.moveUpcoming(command.from - 1, command.to - 1);
        return;
      case 'loop':
        player.setLoopMode(command.mode);
        return;
      case 'dislike': {
        // The database row is the listener's own; the LIVE effect touches a
        // room. Only somebody in this session — its owner or a requester —
        // gets to pull a song out of everyone's queue and skip it. Anyone
        // else's dislike still shapes their own recommendations next time.
        if (!room.music.isSessionListener(command.guildId, command.issuedBy)) {
          logger.info(
            { guildId: command.guildId, issuedBy: command.issuedBy },
            'Dislike from someone outside the session; stored only',
          );
          return;
        }
        // The dashboard sends the canonical key; a queued track may be keyed
        // either by the candidate it was chosen as (`sourceKey`) or by the
        // upload's own spelling, so both have to be compared before deciding
        // that the song being rejected is the one in the speakers. When it
        // is, the track itself is handed over so BOTH of its spellings join
        // the session's exclusion, exactly as a Discord dislike would.
        const current = player.queue.current;
        const playing =
          current !== null &&
          (current.sourceKey === command.trackKey ||
            identityOf(current.author, current.title).key === command.trackKey)
            ? current
            : null;
        room.music.applyDislike(command.guildId, playing ?? { trackKey: command.trackKey });
        if (command.skipIfPlaying && playing !== null) await player.skip();
        return;
      }
      case 'undislike':
        if (!room.music.isSessionListener(command.guildId, command.issuedBy)) return;
        room.music.forgetDislike(command.guildId, command.trackKey);
        return;
      case 'sync-settings':
        if (command.stayConnected !== undefined) player.setStayConnected(command.stayConnected);
        if (command.autoplayEnabled !== undefined) {
          player.setAutoplayEnabled(command.autoplayEnabled);
        }
        return;
    }
  }
}
