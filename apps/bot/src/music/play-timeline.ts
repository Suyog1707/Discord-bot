/**
 * Where the time goes between pressing Enter on `/play` and hearing it.
 *
 * Every mark is an offset from the moment Discord created the interaction,
 * read out of its snowflake — so the Discord → router leg, the router's own
 * work and the queue hop are all inside the numbers, rather than invisible
 * before the first one. "It feels slow" becomes a line that says which part.
 *
 * A mark that did not happen is left out rather than reported as zero: a
 * gateway command has no router, a bot already in the channel does not join,
 * and a song queued behind another does not start.
 */
import { SnowflakeUtil } from 'discord.js';

export interface PlayMarks {
  readonly interactionId: string;
  /** The router queued it. */
  readonly routedAt?: number | undefined;
  /** This container took it off the queue. */
  readonly pickedUpAt?: number | undefined;
  /** The command started running, after the guards. */
  readonly executeAt: number;
  /** The voice join was about to be sent — everything before this is setup. */
  readonly joinStartedAt?: number | undefined;
  /** Voice connected, or the room turned out to be held already. */
  readonly joinedAt?: number | undefined;
  /** The query became tracks. */
  readonly resolvedAt?: number | undefined;
  /** Lavalink was asked to play. */
  readonly playRequestedAt?: number | undefined;
  /** Lavalink reported the track started. */
  readonly audioAt?: number | undefined;
}

export interface PlayTimeline {
  readonly routedMs?: number;
  readonly pickedUpMs?: number;
  readonly executeMs: number;
  readonly joinStartedMs?: number;
  readonly joinedMs?: number;
  readonly resolvedMs?: number;
  readonly playRequestedMs?: number;
  readonly audioMs?: number;
}

export function playTimeline(marks: PlayMarks): PlayTimeline {
  const pressedAt = SnowflakeUtil.timestampFrom(marks.interactionId);
  const since = (at: number | undefined): number | undefined =>
    at === undefined ? undefined : at - pressedAt;

  const offsets = {
    routedMs: since(marks.routedAt),
    pickedUpMs: since(marks.pickedUpAt),
    joinStartedMs: since(marks.joinStartedAt),
    joinedMs: since(marks.joinedAt),
    resolvedMs: since(marks.resolvedAt),
    playRequestedMs: since(marks.playRequestedAt),
    audioMs: since(marks.audioAt),
  };

  return {
    executeMs: marks.executeAt - pressedAt,
    ...Object.fromEntries(Object.entries(offsets).filter(([, value]) => value !== undefined)),
  };
}
