/**
 * What this listener actually likes, derived from what they actually did.
 *
 * The signal is already being recorded: every finished track writes a
 * `SongHistory` row carrying `playedMs`, `durationMs` and `skipped`. That is a
 * far better preference signal than anything a user would type, because nobody
 * lies to a skip button. This module turns those rows into affinities the
 * scorer can read in one query.
 *
 * Two design points worth stating outright:
 *
 * Completion is measured *relative to this listener's own baseline*. Someone who
 * skims and skips constantly has a low baseline, and a 70%-played track is a
 * strong endorsement from them; someone who lets everything run has a high one,
 * and the same 70% means they reached for the button. Scoring against a fixed
 * threshold would read the second listener's dislikes as mild approval.
 *
 * Old plays decay but never vanish. Recent behaviour has to dominate or the
 * radio cannot follow a mood, but a taste built over months should not be erased
 * by one evening of somebody else's music — so weight halves every two weeks
 * rather than falling off a cliff.
 */
import type { PrismaClient } from '@discord-music/database';

import { getLogger } from '../lib/logger.js';

import type { CacheService } from './cache.js';
import type { LastFmService } from './lastfm.js';
import { normaliseArtist, primaryArtist } from './musicbrainz.js';

const logger = getLogger('taste');

/** Plays older than this contribute almost nothing; the query stays bounded. */
const HISTORY_WINDOW_DAYS = 120;
const HISTORY_MAX_ROWS = 1_000;
/** Weight halves every fortnight — recent enough to follow a mood, slow enough to remember. */
const DECAY_HALF_LIFE_DAYS = 14;

/**
 * Recompute at most this often. Autoplay fires on every track change and the
 * aggregate barely moves between two songs, so this is the difference between
 * one query per session and one per track.
 */
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const PROFILE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Below this many plays the aggregate is mostly noise, so affinities are damped
 * toward neutral rather than trusted. A guild's third-ever song should not
 * establish a permanent favourite artist.
 */
const CONFIDENCE_FULL_SAMPLE = 25;

/** Tags Last.fm uses that actually name a language, mapped to a canonical form. */
const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  hindi: 'hindi',
  bollywood: 'hindi',
  desi: 'hindi',
  punjabi: 'punjabi',
  bhangra: 'punjabi',
  tamil: 'tamil',
  kollywood: 'tamil',
  telugu: 'telugu',
  tollywood: 'telugu',
  bengali: 'bengali',
  marathi: 'marathi',
  urdu: 'urdu',
  'k-pop': 'korean',
  kpop: 'korean',
  korean: 'korean',
  'j-pop': 'japanese',
  jpop: 'japanese',
  japanese: 'japanese',
  spanish: 'spanish',
  latin: 'spanish',
  reggaeton: 'spanish',
  french: 'french',
  arabic: 'arabic',
  english: 'english',
};

export interface TasteProfile {
  /** Normalised artist -> affinity in [-1, 1]. */
  readonly artistAffinity: Readonly<Record<string, number>>;
  /** Tag -> affinity in [-1, 1]. Carries genre and mood together. */
  readonly tagAffinity: Readonly<Record<string, number>>;
  /** Language -> share of listening in [0, 1]. Sums to roughly 1 when known. */
  readonly languageAffinity: Readonly<Record<string, number>>;
  /** This listener's own baseline completion, in [0, 1]. */
  readonly completionRate: number;
  readonly sampleSize: number;
  /**
   * How much to trust the above, in [0, 1]. The scorer multiplies personal
   * signals by this so a thin profile contributes proportionally less.
   */
  readonly confidence: number;
}

export const EMPTY_TASTE_PROFILE: TasteProfile = {
  artistAffinity: {},
  tagAffinity: {},
  languageAffinity: {},
  completionRate: 0.7,
  sampleSize: 0,
  confidence: 0,
};

/** Live recency context, read fresh every time — it changes on every track. */
export interface RecentContext {
  /** Identifiers played recently, newest first. Drives the repeat penalty. */
  readonly identifiers: readonly string[];
  /** Normalised artists played recently, newest first. Drives the artist penalty. */
  readonly artists: readonly string[];
  /** Identifiers the listener skipped early. Weighted more heavily against. */
  readonly skipped: readonly string[];
}

export const EMPTY_RECENT_CONTEXT: RecentContext = {
  identifiers: [],
  artists: [],
  skipped: [],
};

export type TasteScope = { readonly guildId: string } | { readonly userId: string };

interface HistoryRow {
  readonly identifier: string;
  readonly author: string;
  readonly title: string;
  readonly durationMs: number;
  readonly playedMs: number;
  readonly skipped: boolean;
  readonly playedAt: Date;
}

function scopeKey(scope: TasteScope): string {
  return 'guildId' in scope ? `guild:${scope.guildId}` : `user:${scope.userId}`;
}

/** Map a stored affinity object back to a plain record, tolerating any shape. */
function readAffinity(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function confidenceFor(sampleSize: number): number {
  return Math.min(1, sampleSize / CONFIDENCE_FULL_SAMPLE);
}

export class UserTasteService {
  readonly #prisma: PrismaClient;
  readonly #cache: CacheService;
  readonly #lastfm: LastFmService;

  constructor(prisma: PrismaClient, cache: CacheService, lastfm: LastFmService) {
    this.#prisma = prisma;
    this.#cache = cache;
    this.#lastfm = lastfm;
  }

  /**
   * The aggregate for one scope.
   *
   * Reads the stored row, recomputing first when it has gone stale. A failure
   * anywhere here returns the empty profile: the recommender then falls back to
   * similarity and novelty alone, which is worse but still musical.
   */
  async profile(scope: TasteScope): Promise<TasteProfile> {
    const key = `taste:${scopeKey(scope)}`;
    const cached = await this.#cache.get<TasteProfile>(key);
    if (cached !== null) return cached;

    try {
      const row = await this.#loadRow(scope);
      const stale = row === null || Date.now() - row.computedAt.getTime() > REFRESH_COOLDOWN_MS;

      const profile = stale
        ? await this.refresh(scope)
        : {
            artistAffinity: readAffinity(row.artistAffinity),
            tagAffinity: readAffinity(row.tagAffinity),
            languageAffinity: readAffinity(row.languageAffinity),
            completionRate: row.completionRate,
            sampleSize: row.sampleSize,
            confidence: confidenceFor(row.sampleSize),
          };

      await this.#cache.set(key, profile, PROFILE_CACHE_TTL_MS);
      return profile;
    } catch (error) {
      logger.warn({ err: error, scope: scopeKey(scope) }, 'Taste profile read failed');
      return EMPTY_TASTE_PROFILE;
    }
  }

  /**
   * Recompute from history and persist.
   *
   * Public so a future scheduled job can warm profiles off the critical path;
   * `profile()` already calls it when the row is stale.
   */
  async refresh(scope: TasteScope): Promise<TasteProfile> {
    const rows = await this.#loadHistory(scope);
    if (rows.length === 0) return EMPTY_TASTE_PROFILE;

    const now = Date.now();
    const weightOf = (playedAt: Date): number => {
      const ageDays = (now - playedAt.getTime()) / 86_400_000;
      return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    };

    // Pass one: this listener's own baseline, so "played 70%" can be read as
    // approval or rejection depending on who is listening.
    let weightedCompletion = 0;
    let totalWeight = 0;
    for (const row of rows) {
      const weight = weightOf(row.playedAt);
      totalWeight += weight;
      weightedCompletion += weight * completionOf(row);
    }
    const completionRate = totalWeight > 0 ? weightedCompletion / totalWeight : 0.7;

    // Pass two: per-artist deviation from that baseline.
    const artistScore = new Map<string, { score: number; weight: number }>();
    for (const row of rows) {
      const artist = normaliseArtist(primaryArtist(row.author));
      if (artist.length === 0) continue;

      const weight = weightOf(row.playedAt);
      // A skip is a stronger statement than a slightly-short play, so it is
      // floored well below whatever the deviation alone would give.
      const deviation = completionOf(row) - completionRate;
      const signal = row.skipped ? Math.min(deviation, -0.35) : deviation;

      const entry = artistScore.get(artist) ?? { score: 0, weight: 0 };
      entry.score += weight * signal;
      entry.weight += weight;
      artistScore.set(artist, entry);
    }

    const artistAffinity: Record<string, number> = {};
    for (const [artist, { score, weight }] of artistScore) {
      if (weight <= 0) continue;
      // Deviations live in roughly [-1, 1] already; the clamp guards outliers
      // such as a 3-second play of a 10-minute track.
      artistAffinity[artist] = clamp(score / weight, -1, 1);
    }

    const favouredArtists = Object.entries(artistAffinity)
      .filter(([, score]) => score > -0.2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 12)
      .map(([artist]) => artist);

    const { tagAffinity, languageAffinity } = await this.#deriveTags(
      favouredArtists,
      artistAffinity,
    );

    const profile: TasteProfile = {
      artistAffinity,
      tagAffinity,
      languageAffinity,
      completionRate,
      sampleSize: rows.length,
      confidence: confidenceFor(rows.length),
    };

    await this.#persist(scope, profile);
    logger.debug(
      {
        scope: scopeKey(scope),
        sampleSize: rows.length,
        artists: Object.keys(artistAffinity).length,
        languages: Object.keys(languageAffinity),
      },
      'Taste profile recomputed',
    );
    return profile;
  }

  /**
   * Recently played tracks and artists for one guild.
   *
   * Deliberately *not* cached and not part of the persisted profile: this is the
   * one input that must reflect the song that just finished, or the recency
   * penalty would let the queue repeat itself within its own cache window.
   */
  async recentContext(guildId: string, limit = 60): Promise<RecentContext> {
    try {
      const rows = await this.#prisma.songHistory.findMany({
        where: { guild: { discordId: guildId } },
        orderBy: { playedAt: 'desc' },
        take: limit,
        select: { identifier: true, author: true, skipped: true, playedMs: true, durationMs: true },
      });

      return {
        identifiers: rows.map((row) => row.identifier),
        artists: rows.map((row) => normaliseArtist(primaryArtist(row.author))),
        // Only an *early* skip is a rejection. Skipping the last ten seconds of
        // a track is how people move on from something they enjoyed.
        skipped: rows
          .filter((row) => row.skipped && completionOf(row) < 0.5)
          .map((row) => row.identifier),
      };
    } catch (error) {
      logger.warn({ err: error, guildId }, 'Recent context read failed');
      return EMPTY_RECENT_CONTEXT;
    }
  }

  /**
   * Tags for the artists this listener favours, weighted by that affinity.
   *
   * Only the top artists are looked up. Tagging every artist in a long history
   * would be dozens of Last.fm calls for a signal that the long tail barely
   * moves, and these are cached for a week besides.
   */
  async #deriveTags(
    artists: readonly string[],
    artistAffinity: Readonly<Record<string, number>>,
  ): Promise<{
    tagAffinity: Record<string, number>;
    languageAffinity: Record<string, number>;
  }> {
    const tagAffinity: Record<string, number> = {};
    const languageWeight: Record<string, number> = {};

    if (!this.#lastfm.enabled || artists.length === 0) {
      return { tagAffinity, languageAffinity: {} };
    }

    const tagLists = await Promise.all(
      artists.map(async (artist) => ({
        artist,
        tags: await this.#lastfm.artistTags(artist).catch(() => []),
      })),
    );

    for (const { artist, tags } of tagLists) {
      const affinity = artistAffinity[artist] ?? 0;
      // Last.fm counts are 0–100 relative to the artist's top tag.
      for (const tag of tags.slice(0, 8)) {
        const strength = Math.min(1, tag.count / 100);
        tagAffinity[tag.name] = (tagAffinity[tag.name] ?? 0) + affinity * strength;

        const language = LANGUAGE_TAGS[tag.name];
        if (language !== undefined) {
          languageWeight[language] = (languageWeight[language] ?? 0) + Math.max(0, strength);
        }
      }
    }

    for (const [tag, score] of Object.entries(tagAffinity)) {
      tagAffinity[tag] = clamp(score, -1, 1);
    }

    // Normalise languages to shares so "70% Hindi" is directly readable.
    const languageTotal = Object.values(languageWeight).reduce((sum, value) => sum + value, 0);
    const languageAffinity: Record<string, number> = {};
    if (languageTotal > 0) {
      for (const [language, weight] of Object.entries(languageWeight)) {
        languageAffinity[language] = weight / languageTotal;
      }
    }

    return { tagAffinity, languageAffinity };
  }

  async #loadHistory(scope: TasteScope): Promise<readonly HistoryRow[]> {
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000);
    const where =
      'guildId' in scope
        ? { guild: { discordId: scope.guildId }, playedAt: { gte: since } }
        : { user: { discordId: scope.userId }, playedAt: { gte: since } };

    return this.#prisma.songHistory.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      take: HISTORY_MAX_ROWS,
      select: {
        identifier: true,
        author: true,
        title: true,
        durationMs: true,
        playedMs: true,
        skipped: true,
        playedAt: true,
      },
    });
  }

  async #loadRow(scope: TasteScope): Promise<{
    artistAffinity: unknown;
    tagAffinity: unknown;
    languageAffinity: unknown;
    completionRate: number;
    sampleSize: number;
    computedAt: Date;
  } | null> {
    const owner = await this.#resolveOwner(scope);
    if (owner === null) return null;

    return this.#prisma.tasteProfile.findFirst({
      where: owner,
      select: {
        artistAffinity: true,
        tagAffinity: true,
        languageAffinity: true,
        completionRate: true,
        sampleSize: true,
        computedAt: true,
      },
    });
  }

  async #persist(scope: TasteScope, profile: TasteProfile): Promise<void> {
    try {
      const owner = await this.#resolveOwner(scope);
      // Nothing to hang the row off yet — the guild or user is not in the
      // database. The in-memory profile is still returned to the caller.
      if (owner === null) return;

      const data = {
        artistAffinity: profile.artistAffinity,
        tagAffinity: profile.tagAffinity,
        languageAffinity: profile.languageAffinity,
        completionRate: profile.completionRate,
        sampleSize: profile.sampleSize,
        computedAt: new Date(),
      };

      await this.#prisma.tasteProfile.upsert({
        where: owner,
        create: { ...owner, ...data },
        update: data,
      });
    } catch (error) {
      // A profile that fails to persist is recomputed next time. Not worth
      // failing a recommendation over.
      logger.warn({ err: error, scope: scopeKey(scope) }, 'Taste profile write failed');
    }
  }

  /** Translate a Discord snowflake to the internal row this profile hangs off. */
  async #resolveOwner(scope: TasteScope): Promise<{ guildId: string } | { userId: string } | null> {
    if ('guildId' in scope) {
      const guild = await this.#prisma.guild.findUnique({
        where: { discordId: scope.guildId },
        select: { id: true },
      });
      return guild === null ? null : { guildId: guild.id };
    }

    const user = await this.#prisma.user.findUnique({
      where: { discordId: scope.userId },
      select: { id: true },
    });
    return user === null ? null : { userId: user.id };
  }
}

/** Fraction of a track actually played, clamped for bad duration data. */
function completionOf(row: { readonly playedMs: number; readonly durationMs: number }): number {
  if (row.durationMs <= 0) return 0;
  return clamp(row.playedMs / row.durationMs, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
