/**
 * Audio-health classification for Lavalink's per-minute `stats` message.
 *
 * Lavalink's audio sender must hand Discord one 20 ms frame at a time, so a
 * playing player ideally accounts for 3000 frames a minute. Two counters say
 * how the minute went wrong:
 *   - `nulled`:  the source had no audio ready (a stalled stream).
 *   - `deficit`: frames neither sent nor nulled, i.e. the sender itself fell
 *                behind (CPU steal, a GC pause). Listeners hear this as a
 *                freeze followed by a fast catch-up burst.
 * This module is pure: it decides the log level and shape, the caller logs.
 */

/** The subset of Lavalink's `stats` payload this module reads. */
export interface LavalinkStatsLike {
  readonly playingPlayers: number;
  readonly memory: { readonly used: number };
  readonly cpu: { readonly systemLoad: number; readonly lavalinkLoad: number };
  /** Null when the session has no players. */
  readonly frameStats: {
    readonly sent: number;
    readonly nulled: number;
    readonly deficit: number;
  } | null;
}

export interface AudioHealthReport {
  /** `warn` when any frame was lost, otherwise `debug`. */
  readonly level: 'warn' | 'debug';
  readonly message: string;
  readonly fields: {
    readonly sent: number;
    readonly nulled: number;
    readonly deficit: number;
    readonly playingPlayers: number;
    /** (nulled + deficit) / (sent + nulled + deficit) * 100, 2 dp. */
    readonly lossPct: number;
    readonly lavalinkLoad: number;
    readonly systemLoad: number;
    readonly memoryUsed: number;
  };
}

/** Returns null when there is nothing to report (no frame stats). */
export function assessAudioHealth(stats: LavalinkStatsLike): AudioHealthReport | null {
  const frames = stats.frameStats;
  if (frames === null) return null;

  const total = frames.sent + frames.nulled + frames.deficit;
  // An idle minute reports 0/0/0; avoid dividing by zero.
  const lossPct =
    total === 0 ? 0 : Math.round(((frames.nulled + frames.deficit) / total) * 10_000) / 100;
  const lost = frames.deficit > 0 || frames.nulled > 0;

  return {
    level: lost ? 'warn' : 'debug',
    message: lost ? 'Lavalink audio frames dropped' : 'Lavalink audio frames healthy',
    fields: {
      sent: frames.sent,
      nulled: frames.nulled,
      deficit: frames.deficit,
      playingPlayers: stats.playingPlayers,
      lossPct,
      lavalinkLoad: stats.cpu.lavalinkLoad,
      systemLoad: stats.cpu.systemLoad,
      memoryUsed: stats.memory.used,
    },
  };
}
