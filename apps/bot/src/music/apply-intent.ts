/**
 * Run one intent against the room that owns it.
 *
 * The single place a serialised request becomes a call on a live player. It
 * runs on the container holding that room, so everything it touches — the
 * queue, the session registry, the dislike ledger — is in-process and works
 * exactly as it always has.
 *
 * Every branch is expressed against `RoomPlayer`, never against a router, so
 * the same function serves a dashboard command arriving over Redis, a sibling
 * container calling in over HTTP, and a local command that never left the
 * process.
 */
import { identityOf } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';

import { summarise, type IntentResult, type RoomIntent } from './intent.js';
import type { RoomPlayer } from './player-router.js';

const logger = getLogger('intent');

export async function applyIntent(room: RoomPlayer, intent: RoomIntent): Promise<IntentResult> {
  const { player, music } = room;

  switch (intent.action) {
    /* ------------------------------------------------------------ transport */
    case 'pause':
      await player.pause();
      return { kind: 'ok' };
    case 'resume':
      await player.resume();
      return { kind: 'ok' };
    case 'skip':
      return { kind: 'track', track: summarise(await player.skip()) };
    case 'stop':
      await player.stop();
      return { kind: 'ok' };
    case 'previous':
      return { kind: 'track', track: summarise(await player.previous()) };
    case 'restart':
      return { kind: 'track', track: summarise(await player.restart()) };
    case 'shuffle': {
      const count = player.queue.upcoming.length;
      player.shuffle();
      return { kind: 'count', count };
    }
    case 'volume':
      await player.setVolume(intent.volume);
      return { kind: 'ok' };
    case 'seek':
      await player.seekTo(intent.positionMs);
      return { kind: 'ok' };
    case 'loop':
      player.setLoopMode(intent.mode);
      return { kind: 'ok' };

    /* ---------------------------------------------------------------- queue */
    case 'jump':
      // Positions are 1-based and relative to the upcoming list, as every
      // queue view shows them.
      return {
        kind: 'track',
        track: summarise(await player.jumpTo(player.queue.currentIndex + intent.position)),
      };
    case 'remove':
      return { kind: 'track', track: summarise(player.removeUpcoming(intent.position - 1)) };
    case 'move':
      return {
        kind: 'track',
        track: summarise(player.moveUpcoming(intent.from - 1, intent.to - 1)),
      };
    case 'swap':
      return player.swapUpcoming(intent.a - 1, intent.b - 1)
        ? { kind: 'ok' }
        : { kind: 'error', message: 'Those positions are not both in the queue.' };
    case 'clear':
      return { kind: 'count', count: player.clearUpcoming() };

    /* -------------------------------------------------------------- session */
    case 'set-listener':
      player.setListener(intent.listenerId);
      return { kind: 'ok' };
    case 'stay-connected':
      player.setStayConnected(intent.enabled);
      return { kind: 'ok' };
    case 'autoplay':
      player.setAutoplayEnabled(intent.enabled);
      return { kind: 'ok' };

    /* ------------------------------------------------------------- dislikes */
    case 'dislike': {
      /**
       * The database row is the listener's own; the LIVE effect touches a
       * room. Only somebody in this session — its owner or a requester — gets
       * to pull a song out of everyone's queue and skip it. Anyone else's
       * dislike still shapes their own recommendations next time.
       */
      if (!music.isSessionListener(intent.guildId, intent.issuedBy)) {
        logger.info(
          { guildId: intent.guildId, issuedBy: intent.issuedBy },
          'Dislike from someone outside the session; stored only',
        );
        return { kind: 'ok' };
      }
      /**
       * A queued track may be keyed either by the candidate it was chosen as
       * (`sourceKey`) or by the upload's own spelling, so both are compared
       * before deciding the song being rejected is the one in the speakers.
       * Compared by key rather than by object identity — the caller may be in
       * another process and cannot hand us the same object.
       */
      const current = player.queue.current;
      const playing =
        current !== null &&
        (current.sourceKey === intent.trackKey ||
          identityOf(current.author, current.title).key === intent.trackKey)
          ? current
          : null;
      music.applyDislike(intent.guildId, playing ?? { trackKey: intent.trackKey });
      if (intent.skipIfPlaying && playing !== null) await player.skip();
      return { kind: 'track', track: summarise(playing) };
    }
    case 'undislike':
      if (!music.isSessionListener(intent.guildId, intent.issuedBy)) return { kind: 'ok' };
      music.forgetDislike(intent.guildId, intent.trackKey);
      return { kind: 'ok' };

    /* ---------------------------------------------------------------- reads */
    case 'snapshot':
      return { kind: 'snapshot', snapshot: player.snapshot() };
    case 'authority':
      return {
        kind: 'authority',
        botVoiceChannelId: player.voiceChannelId,
        hostId: music.sessionDj.host(intent.guildId),
        sessionDjIds: music.sessionDj.djIds(intent.guildId),
      };
  }
}
