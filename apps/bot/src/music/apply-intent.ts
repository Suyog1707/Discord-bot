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
import { decideJoin } from './join-decision.js';
import { formatTrackDuration } from './track.js';
import type { RoomPlayer } from './player-router.js';

const logger = getLogger('intent');

export async function applyIntent(room: RoomPlayer, intent: RoomIntent): Promise<IntentResult> {
  const { player, music } = room;

  switch (intent.action) {
    /* ------------------------------------------------------------ transport */
    /**
     * The checks that used to sit in the command live here now.
     * Whether playback is already paused is a fact about the room, and the
     * room is what this function has — asking for it separately would cost a
     * second round trip to learn something the owner already knows.
     */
    case 'pause':
      if (player.paused) return { kind: 'error', message: 'Already paused — use `/resume`.' };
      await player.pause();
      return { kind: 'ok' };
    case 'resume':
      if (!player.paused) return { kind: 'error', message: 'Playback is not paused.' };
      await player.resume();
      return { kind: 'ok' };
    case 'skip':
      return { kind: 'track', track: summarise(await player.skip()) };
    case 'stop':
      await player.stop();
      return { kind: 'ok' };
    case 'previous': {
      const track = await player.previous();
      return track === null
        ? { kind: 'error', message: 'There is no earlier track — this is the start of the queue.' }
        : { kind: 'track', track: summarise(track) };
    }
    case 'restart': {
      const track = await player.restart();
      return track === null
        ? { kind: 'error', message: 'Nothing is playing.' }
        : { kind: 'track', track: summarise(track) };
    }
    case 'shuffle': {
      const count = player.queue.upcoming.length;
      player.shuffle();
      return { kind: 'count', count };
    }
    case 'volume':
      await player.setVolume(intent.volume);
      return { kind: 'ok' };
    case 'seek': {
      const current = player.queue.current;
      if (current === null) return { kind: 'error', message: 'Nothing is playing.' };
      if (current.isStream) {
        return { kind: 'error', message: 'Live streams cannot be seeked.' };
      }
      if (intent.positionMs > current.durationMs) {
        return {
          kind: 'error',
          message: `That is past the end — the track is ${formatTrackDuration(current)} long.`,
        };
      }
      await player.seekTo(intent.positionMs);
      return { kind: 'track', track: summarise(current) };
    }
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
    case 'remove': {
      const removed = player.removeUpcoming(intent.position - 1);
      return removed === null
        ? {
            kind: 'error',
            message:
              `Nothing at position ${String(intent.position)} — the queue has ` +
              `${String(player.queue.upcoming.length)} upcoming track(s).`,
          }
        : { kind: 'track', track: summarise(removed) };
    }
    case 'move': {
      const moved = player.moveUpcoming(intent.from - 1, intent.to - 1);
      return moved === null
        ? { kind: 'error', message: 'Those positions are not both in the queue.' }
        : { kind: 'track', track: summarise(moved) };
    }
    case 'swap':
      return player.swapUpcoming(intent.a - 1, intent.b - 1)
        ? { kind: 'ok' }
        : { kind: 'error', message: 'Those positions are not both in the queue.' };
    case 'clear':
      return { kind: 'count', count: player.clearUpcoming() };

    /* ---------------------------------------------------------------- join */
    /**
     * `/play`'s second half, run where the queue is.
     *
     * The reply needs three facts that only exist after the tracks land, and
     * reading them separately would be three more round trips racing the music
     * itself — so they come back with the write.
     */
    case 'enqueue': {
      const { startedPlayback } = await player.enqueue(intent.tracks, { next: intent.next });
      return {
        kind: 'enqueued',
        startedPlayback,
        upcomingCount: player.queue.upcoming.length,
        resumed: music.takeResumeNotice(intent.guildId),
      };
    }

    /**
     * `/join`'s whole body.
     *
     * Entering a channel has always brought back the queue it was left with;
     * what it never did was start playing, because only `/play` ever called
     * `jumpTo` — as a side effect of queuing the song it was given. So a
     * channel with a saved queue could be rejoined and would sit there silent.
     */
    case 'join-session': {
      const decision = decideJoin({
        isPlaying: player.isPlaying,
        hasCurrentTrack: player.queue.current !== null,
        currentIndex: player.queue.currentIndex,
      });

      // Somebody's session is already running here. Taking the host seat and
      // pointing autoplay at whoever typed the command would hijack it, so
      // this is the one branch that touches nothing.
      if (decision.kind === 'already-playing') {
        return {
          kind: 'joined',
          outcome: 'already-playing',
          current: summarise(player.queue.current),
          upcomingCount: player.queue.upcoming.length,
          resumed: null,
        };
      }

      /**
       * Whoever summons the bot runs the session.
       *
       * A restored queue remembers the listener it belonged to, but that
       * person may well have gone home — their taste should not quietly drive
       * a room they are not in. `setListener` moves autoplay to the caller
       * and, through `onListenerChange`, makes them host; `setHost` is
       * first-writer-wins, so naming them directly also covers the case where
       * they *are* the restored listener and `setListener` therefore has
       * nothing to change.
       */
      player.setListener(intent.issuedBy);
      music.sessionDj.setHost(intent.guildId, intent.issuedBy);

      const resumed = music.takeResumeNotice(intent.guildId);
      const current = player.queue.current;
      if (decision.kind !== 'resume' || current === null) {
        return { kind: 'joined', outcome: 'empty', current: null, upcomingCount: 0, resumed };
      }

      await player.jumpTo(decision.fromIndex);
      return {
        kind: 'joined',
        outcome: 'resumed',
        current: summarise(current),
        upcomingCount: player.queue.upcoming.length,
        resumed,
      };
    }

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
