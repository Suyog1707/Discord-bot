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
import { normaliseTags } from './genre-taxonomy.js';
import { languageFromTag } from './language.js';
import type { LastFmService, LastFmTag } from './lastfm.js';
import { type MusicBrainzService, normaliseArtist, primaryArtist } from './musicbrainz.js';
// Value import from scoring is safe: scoring imports only *types* from here,
// so the cycle is erased at compile time.
import { trackKeyOf } from './scoring.js';

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
/** How long a loved song rests before it may be resurfaced by autoplay. */
const FAVOURITE_COOLDOWN_MS = 48 * 60 * 60_000;

/**
 * Below this many plays the aggregate is mostly noise, so affinities are damped
 * toward neutral rather than trusted. A guild's third-ever song should not
 * establish a permanent favourite artist.
 */
const CONFIDENCE_FULL_SAMPLE = 25;

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
  /**
   * Canonical track keys played recently, newest first. This is the key the
   * anti-repeat logic actually fires on: Last.fm candidates carry no Lavalink
   * identifier, so matching on identifiers alone silently disabled every
   * repeat-suppression signal for the recommender path.
   */
  readonly trackKeys: readonly string[];
  /** Titles played recently, newest first. Context for the LLM reranker. */
  readonly titles: readonly string[];
  /** Normalised artists played recently, newest first. Drives the artist penalty. */
  readonly artists: readonly string[];
  /** Identifiers the listener skipped early. Weighted more heavily against. */
  readonly skipped: readonly string[];
  /** Canonical track keys of early skips, for candidates with no identifier. */
  readonly skippedKeys: readonly string[];
  /**
   * Artists of recent USER-originated, non-skipped plays, newest first. The
   * "session sounds like this" positive signal reads these — never the full
   * artist list, which includes autoplay's own picks and would let the
   * recommender reward proximity to its previous output (drift).
   */
  readonly anchorArtists?: readonly string[];
  /**
   * Artists of the early skips, one entry per skip. Repeats matter: two skips
   * of one artist say more than one, and the scorer escalates accordingly.
   */
  readonly skippedArtists?: readonly string[];
}

export const EMPTY_RECENT_CONTEXT: RecentContext = {
  identifiers: [],
  trackKeys: [],
  titles: [],
  artists: [],
  skipped: [],
  skippedKeys: [],
  anchorArtists: [],
  skippedArtists: [],
};

export type TasteScope = { readonly guildId: string } | { readonly userId: string };

interface HistoryRow {
  readonly identifier: string;
  readonly author: string;
  readonly title: string;
  readonly durationMs: number;
  readonly playedMs: number;
  readonly skipped: boolean;
  readonly origin: string;
  readonly playedAt: Date;
}

/**
 * How much one play counts toward the long-term profile, by where it came from.
 *
 * A person choosing a song is the profile's ground truth: full weight. An
 * autoplay play the listener merely tolerated says little — the recommender
 * picked it, not the person — so it counts for a fraction; letting it count
 * fully would feed the recommender's output back in as taste (drift, in slow
 * motion). Two autoplay cases carry real information and keep more weight: a
 * skip is genuine negative feedback at full strength, and a near-complete
 * listen is a mild endorsement.
 */
export function originWeightOf(row: {
  readonly origin: string;
  readonly skipped: boolean;
  readonly playedMs: number;
  readonly durationMs: number;
}): number {
  if (row.origin !== 'autoplay') return 1;
  if (row.skipped) return 1;
  return completionOf(row) >= 0.85 ? 0.6 : 0.35;
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
  readonly #musicbrainz: MusicBrainzService;

  constructor(
    prisma: PrismaClient,
    cache: CacheService,
    lastfm: LastFmService,
    musicbrainz: MusicBrainzService,
  ) {
    this.#prisma = prisma;
    this.#cache = cache;
    this.#lastfm = lastfm;
    this.#musicbrainz = musicbrainz;
  }

  /**
   * The aggregate for one scope.
   *
   * Reads the stored row, recomputing first when it has gone stale. A failure
   * anywhere here returns the empty profile: the recommender then falls back to
   * similarity and novelty alone, which is worse but still musical.
   */
  async profile(
    scope: TasteScope,
    options: {
      /**
       * Whether a stale or missing row may be recomputed now. The recompute
       * reads a thousand history rows and tags a dozen artists; on the
       * synchronous playback path — a listener waiting in silence — a
       * slightly old profile is worth more than a fresh one that arrives
       * late. Default true; autoplay passes false for per-listener profiles
       * unless it is running in the background.
       */
      readonly allowRefresh?: boolean;
    } = {},
  ): Promise<TasteProfile> {
    const key = `taste:${scopeKey(scope)}`;
    const cached = await this.#cache.get<TasteProfile>(key);
    if (cached !== null) return cached;

    try {
      const row = await this.#loadRow(scope);
      const stale = row === null || Date.now() - row.computedAt.getTime() > REFRESH_COOLDOWN_MS;

      if (stale && options.allowRefresh === false) {
        // Serve what exists without paying for a recompute; the next
        // background pass refreshes it. Not cached, so that pass still runs.
        if (row === null) return EMPTY_TASTE_PROFILE;
        return {
          artistAffinity: readAffinity(row.artistAffinity),
          tagAffinity: readAffinity(row.tagAffinity),
          languageAffinity: readAffinity(row.languageAffinity),
          completionRate: row.completionRate,
          sampleSize: row.sampleSize,
          confidence: confidenceFor(row.sampleSize),
        };
      }

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
    const weightOf = (row: HistoryRow): number => {
      const ageDays = (now - row.playedAt.getTime()) / 86_400_000;
      return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS) * originWeightOf(row);
    };

    // Pass one: this listener's own baseline, so "played 70%" can be read as
    // approval or rejection depending on who is listening.
    let weightedCompletion = 0;
    let totalWeight = 0;
    for (const row of rows) {
      const weight = weightOf(row);
      totalWeight += weight;
      weightedCompletion += weight * completionOf(row);
    }
    const completionRate = totalWeight > 0 ? weightedCompletion / totalWeight : 0.7;

    // Pass two: per-artist deviation from that baseline.
    const artistScore = new Map<string, { score: number; weight: number }>();
    for (const row of rows) {
      const artist = normaliseArtist(primaryArtist(row.author));
      if (artist.length === 0) continue;

      const weight = weightOf(row);
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

    // Ranked by how much this listener *plays* an artist, not by how much they
    // enjoy them. Gating on positive affinity was wrong: a live probe against a
    // real guild found every artist scoring negative — the room skips a lot —
    // which left the tag list empty and, with it, the language. Someone who
    // skips half the Hindi songs they put on is still a Hindi listener. Affinity
    // still decides how each artist's tags are *weighted* below; it just no
    // longer decides whether they are looked at.
    const listenedArtists = [...artistScore.entries()]
      .sort(([, a], [, b]) => b.weight - a.weight)
      .slice(0, 12)
      .map(([artist]) => artist);

    const { tagAffinity, languageAffinity } = await this.#deriveTags(
      listenedArtists,
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
        select: {
          identifier: true,
          author: true,
          title: true,
          skipped: true,
          origin: true,
          playedMs: true,
          durationMs: true,
        },
      });

      // Only an *early* skip is a rejection. Skipping the last ten seconds of
      // a track is how people move on from something they enjoyed.
      const earlySkips = rows.filter((row) => row.skipped && completionOf(row) < 0.5);

      return {
        identifiers: rows.map((row) => row.identifier),
        trackKeys: rows.map((row) => trackKeyOf(row.author, row.title)),
        titles: rows.map((row) => row.title),
        artists: rows.map((row) => normaliseArtist(primaryArtist(row.author))),
        skipped: earlySkips.map((row) => row.identifier),
        skippedKeys: earlySkips.map((row) => trackKeyOf(row.author, row.title)),
        anchorArtists: rows
          .filter((row) => row.origin !== 'autoplay' && !row.skipped)
          .map((row) => normaliseArtist(primaryArtist(row.author))),
        skippedArtists: earlySkips.map((row) => normaliseArtist(primaryArtist(row.author))),
      };
    } catch (error) {
      logger.warn({ err: error, guildId }, 'Recent context read failed');
      return EMPTY_RECENT_CONTEXT;
    }
  }

  /**
   * Songs this guild demonstrably loves and has not heard in a while.
   *
   * "Loved" is behavioural — played essentially to completion, never
   * early-skipped — and "a while" matters as much as the love: resurfacing a
   * favourite too soon is a repeat, resurfacing it after days is a welcome
   * return. These become the `history` candidate source, so a great radio
   * session is not condemned to permanent novelty.
   */
  async favouriteTracks(
    guildId: string,
    limit = 20,
  ): Promise<readonly { title: string; artist: string; identifier: string }[]> {
    const cooldown = new Date(Date.now() - FAVOURITE_COOLDOWN_MS);
    try {
      const rows = await this.#prisma.songHistory.findMany({
        where: { guild: { discordId: guildId }, skipped: false },
        orderBy: { playedAt: 'desc' },
        take: 300,
        select: {
          identifier: true,
          author: true,
          title: true,
          playedMs: true,
          durationMs: true,
          origin: true,
          playedAt: true,
        },
      });

      // Aggregate per canonical song: total plays, best completion, last heard.
      // A play the user chose counts double a completed autoplay play — both
      // are positive signals, but an explicit choice is the stronger one.
      const bySong = new Map<
        string,
        { title: string; artist: string; identifier: string; plays: number; lastPlayedAt: Date }
      >();
      for (const row of rows) {
        if (completionOf(row) < 0.85) continue;
        const playWeight = row.origin === 'autoplay' ? 1 : 2;
        const key = trackKeyOf(row.author, row.title);
        const existing = bySong.get(key);
        if (existing === undefined) {
          bySong.set(key, {
            title: row.title,
            artist: row.author,
            identifier: row.identifier,
            plays: playWeight,
            lastPlayedAt: row.playedAt,
          });
        } else {
          existing.plays += playWeight;
          if (row.playedAt > existing.lastPlayedAt) existing.lastPlayedAt = row.playedAt;
        }
      }

      return [...bySong.values()]
        .filter((song) => song.lastPlayedAt < cooldown)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, limit)
        .map(({ title, artist, identifier }) => ({ title, artist, identifier }));
    } catch (error) {
      logger.warn({ err: error, guildId }, 'Favourite tracks read failed');
      return [];
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

    if (artists.length === 0) return { tagAffinity, languageAffinity: {} };

    /**
     * Tags for one artist, from Last.fm if it is configured and MusicBrainz
     * otherwise.
     *
     * The fallback is load-bearing rather than decorative. Language matching —
     * the thing that keeps a Hindi session Hindi — is driven entirely by tags,
     * and a live probe showed it silently producing nothing whenever Last.fm was
     * absent. MusicBrainz needs no API key and returned "bollywood, filmi,
     * indian pop" for the same artist, which is exactly the signal required. Its
     * tags are coarser and unweighted, so they are treated as a uniform medium
     * strength rather than being given Last.fm's confidence.
     */
    const tagsFor = async (artist: string): Promise<readonly LastFmTag[]> => {
      if (this.#lastfm.enabled) {
        const fromLastFm = await this.#lastfm.artistTags(artist).catch(() => []);
        if (fromLastFm.length > 0) return fromLastFm;
      }
      const canonical = await this.#musicbrainz.canonicalArtist(artist).catch(() => null);
      return (canonical?.tags ?? []).map((name) => ({ name, count: 60 }));
    };

    const tagLists = await Promise.all(
      artists.map(async (artist) => ({ artist, tags: await tagsFor(artist) })),
    );

    for (const { artist, tags } of tagLists) {
      const affinity = artistAffinity[artist] ?? 0;
      // Normalised genre and family keys sit alongside the raw tags, so a
      // candidate tagged "hindi film songs" and one tagged "bollywood" read
      // the same affinity instead of two unrelated ones.
      // Derived from the same top-eight tags the raw loop reads, weighted by
      // the strongest tag that produced them, and never written when the raw
      // loop is about to write the very same key — a genre inferred from
      // evidence must not outweigh the evidence.
      const evidence = tags.slice(0, 8);
      const rawNames = new Set(evidence.map((tag) => tag.name));
      const normalised = normaliseTags(evidence.map((tag) => tag.name));
      const strongest = evidence.reduce((best, tag) => Math.max(best, tag.count), 0);
      const genreStrength = Math.min(1, strongest / 100) * 0.8;
      for (const key of new Set([...normalised.genres, ...normalised.families])) {
        if (rawNames.has(key)) continue;
        tagAffinity[key] = (tagAffinity[key] ?? 0) + affinity * genreStrength;
      }
      // Last.fm counts are 0–100 relative to the artist's top tag.
      for (const tag of tags.slice(0, 8)) {
        const strength = Math.min(1, tag.count / 100);
        tagAffinity[tag.name] = (tagAffinity[tag.name] ?? 0) + affinity * strength;

        const language = languageFromTag(tag.name);
        if (language !== null) {
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
        origin: true,
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

/**
 * The floor an individual profile's blend weight is held at.
 *
 * Weights are scaled by confidence, and a brand-new listener's confidence is
 * exactly zero — so without a floor the whole blend can weigh nothing and the
 * division below has no denominator. The floor is small enough that an empty
 * profile never dominates a real one; it just keeps it in the room.
 */
const MIN_BLEND_WEIGHT = 0.05;

/** Extra confidence per additional evidenced profile in a blend. Small on purpose. */
const AGREEMENT_BONUS = 0.05;

/**
 * Merge several taste profiles into the one the scorer reads.
 *
 * Autoplay is playing for a room, not for a person. The guild's aggregate says
 * what this server sounds like; each present listener's own profile says what
 * *they* came for. Neither alone is right — guild-only is why the radio ignored
 * whoever was actually in the channel, and listener-only would let one person's
 * history hijack a shared queue — so the caller supplies both with weights and
 * this blends them.
 *
 * Each profile's stated weight is multiplied by its own confidence, because a
 * profile built from four plays should not argue with one built from four
 * hundred merely because the caller asked for it loudly.
 *
 * A key missing from a profile counts as zero rather than being skipped. That
 * matters in two ways: affinities are signed and centred on zero, so absence is
 * genuinely neutral and a thin profile cannot project a full-strength opinion
 * into the blend; and `languageAffinity` is a share distribution, which only
 * stays a distribution if every profile divides by the same total.
 *
 * Confidence is the weighted mean of the inputs' confidence, with a small
 * bonus per additional evidenced profile: several thin profiles are still
 * thin — `dampen()` relies on this number to pull noise toward neutral, and
 * a sum would let three near-empty listeners add up to total certainty.
 *
 * Pure — no I/O, no clock.
 */
export function blendProfiles(
  profiles: readonly { readonly profile: TasteProfile; readonly weight: number }[],
): TasteProfile {
  if (profiles.length === 0) return EMPTY_TASTE_PROFILE;

  const weighted = profiles.map(({ profile, weight }) => {
    const stated = Math.max(0, weight);
    return {
      profile,
      stated,
      effective: Math.max(MIN_BLEND_WEIGHT, stated * profile.confidence),
    };
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.effective, 0);

  const blendMap = (
    pick: (profile: TasteProfile) => Readonly<Record<string, number>>,
  ): Record<string, number> => {
    const totals: Record<string, number> = {};
    for (const { profile, effective } of weighted) {
      for (const [key, value] of Object.entries(pick(profile))) {
        totals[key] = (totals[key] ?? 0) + effective * value;
      }
    }
    for (const [key, total] of Object.entries(totals)) {
      totals[key] = total / totalWeight;
    }
    return totals;
  };

  const completionRate =
    weighted.reduce((sum, entry) => sum + entry.effective * entry.profile.completionRate, 0) /
    totalWeight;

  return {
    artistAffinity: blendMap((profile) => profile.artistAffinity),
    tagAffinity: blendMap((profile) => profile.tagAffinity),
    languageAffinity: blendMap((profile) => profile.languageAffinity),
    completionRate,
    sampleSize: weighted.reduce((sum, entry) => sum + entry.profile.sampleSize, 0),
    confidence: Math.min(
      1,
      weighted.reduce((sum, entry) => sum + entry.effective * entry.profile.confidence, 0) /
        totalWeight +
        AGREEMENT_BONUS *
          Math.max(0, weighted.filter((entry) => entry.profile.confidence > 0).length - 1),
    ),
  };
}
