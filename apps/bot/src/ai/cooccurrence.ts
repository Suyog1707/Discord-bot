/**
 * Behavioural similarity - what this room plays, saves and lists *together*.
 *
 * Every other similarity signal the recommender has is editorial: Last.fm's
 * "similar artists", shared tags, a genre taxonomy. They all describe music in
 * the abstract, and they are all blind to the one thing this room actually
 * demonstrated - that these two songs belong next to each other *here*. A guild
 * that plays a Bollywood ballad straight into a Punjabi club track every single
 * night has stated a relationship no tag catalogue will ever contain, and a
 * listener who saved both songs in the same sitting has stated another.
 *
 * This module reads that statement back out of data the bot already stores, as
 * a co-occurrence graph: for each canonical track key, the tracks that keep
 * showing up near it, weighted by how strong the evidence is.
 *
 * Four kinds of evidence, in descending strength:
 *
 * Adjacency (1.0) - two songs played back to back in the same guild inside
 * twenty minutes. This is the strongest signal in the file because somebody was
 * in the room when it happened and did not skip. A play that did not survive
 * halfway is not evidence of anything and, crucially, *breaks* the chain rather
 * than being deleted from it: if the room skipped B, then A and C were never
 * heard next to each other, they were merely stored next to each other.
 *
 * Same session (0.5) - the same person played both within a day but not back to
 * back. Weaker (the room's mood can turn over inside a day) but still a real
 * pairing, and it is what connects songs a shuffle happened to separate.
 *
 * Playlist co-membership (0.6) - a person deliberately put these two songs in
 * one list. Curation beats accident, which is why it outranks the same-day
 * signal, but it ranks below adjacency because a playlist is aspirational and a
 * completed play is not.
 *
 * Favourite co-membership (0.4) - the weakest: a saved-tracks list is a library,
 * not a sequence. Only lists small enough to still mean something are read at
 * all, and only nearby entries are paired, because "both in my 800 saved songs"
 * says nothing.
 *
 * Two bounding rules keep this from becoming an O(n^2) trap. Every list is
 * paired within a sliding window of neighbours rather than fully crossed, so a
 * hundred-track playlist produces a couple of thousand pairs and not five
 * thousand; and each row keeps only its strongest neighbours. Both caps bite
 * exactly where the discarded pairs were the least informative.
 *
 * Finally, every row is normalised so its strongest neighbour is 1. Raw sums
 * would make the graph a popularity contest - the track the guild plays nightly
 * would out-weigh everything for every other track - where what the scorer
 * needs is "of the things seen near *this* song, how central is that one".
 */
import { PlaylistVisibility, type PrismaClient } from '@discord-music/database';

import { getLogger } from '../lib/logger.js';

import type { CacheService } from './cache.js';
import { identityOf } from './identity.js';

const logger = getLogger('cooccurrence');

/**
 * Long enough that a queue does not re-run four queries per song, short enough
 * that tonight's listening starts influencing tonight's autoplay.
 */
const SIGNALS_CACHE_TTL_MS = 10 * 60_000;

/** Every query is bounded - a guild with two years of history must not stall autoplay. */
const HISTORY_WINDOW_DAYS = 120;
const HISTORY_MAX_ROWS = 1_000;
const PLAYLISTS_MAX = 12;
const PLAYLIST_TRACKS_MAX = 100;
const FAVORITES_MAX_ROWS = 600;

/**
 * A saved-tracks list past this size is a library rather than a taste
 * statement; pairing inside it would relate everything to everything.
 */
const FAVORITES_PER_USER_MAX = 200;

/** Back to back: the next song started while the room was still the same room. */
const ADJACENCY_WINDOW_MS = 20 * 60_000;

/** Same listening day - the loosest pairing still worth recording. */
const SAME_DAY_WINDOW_MS = 24 * 60 * 60_000;

const WEIGHT_ADJACENT = 1;
const WEIGHT_ADJACENT_MIXED = 0.6;
const WEIGHT_ADJACENT_AUTOPLAY = 0.3;
const WEIGHT_SAME_DAY = 0.5;
const WEIGHT_PLAYLIST = 0.6;
const WEIGHT_FAVORITE = 0.4;

/** Below this the track did not really play, whatever the row says. */
const MIN_COMPLETION = 0.5;

/**
 * How many following entries of an ordered list a given entry is paired with.
 * Crossing a list of n items fully is n^2/2 pairs; pairing each item with its
 * next 25 is 25n. Position order in a playlist and save order in a library are
 * both meaningful, so the pairs this drops are the distant - least related -
 * ones.
 */
const NEIGHBOUR_WINDOW = 25;

/**
 * Neighbours kept per row after normalisation. Bounds both the memory footprint
 * and the size of the cached JSON; everything below the fortieth neighbour of a
 * row is noise that normalisation has already scaled to near zero.
 */
const MAX_NEIGHBOURS = 40;
/**
 * Ceiling on rows the finished graph may hold. The cache layer sizes its
 * memory tier for small entries; an unbounded graph over a heavy guild would
 * be megabytes of JSON churned every ten minutes. Rows with the weakest
 * strongest-edge go first — they carry the least signal.
 */
const MAX_ROWS = 600;

/** How `neighbourhoodScore` splits its trust between the two graphs. */
const TRACK_TERM_WEIGHT = 0.7;
const ARTIST_TERM_WEIGHT = 0.3;

export interface CooccurrenceSignals {
  /** trackKey to (trackKey to weight 0..1) - songs the room plays near each other, saves together, lists together. */
  readonly tracks: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** artistKey to (artistKey to weight) - artists consumed together. */
  readonly artists: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** A failure, or a room with no shared history, is an absence of signal - never an error. */
const EMPTY_SIGNALS: CooccurrenceSignals = {
  tracks: new Map<string, ReadonlyMap<string, number>>(),
  artists: new Map<string, ReadonlyMap<string, number>>(),
};

/**
 * The cached form.
 *
 * A Map JSON-round-trips to `{}`, so caching the signals as they stand would
 * hand the Redis tier back a graph with no edges at all - silently, and looking
 * exactly like a room that has never played anything. Nested entry arrays
 * survive the trip; `rehydrate` puts the Maps back.
 */
interface CachedSignals {
  readonly tracks: readonly CachedRow[];
  readonly artists: readonly CachedRow[];
}

type CachedRow = readonly [key: string, neighbours: readonly (readonly [string, number])[]];

/** One song, reduced to the two keys the graphs are built from. */
interface Entry {
  readonly key: string;
  readonly artistKey: string;
}

/** A history row placed on the timeline. */
interface Play {
  readonly entry: Entry;
  readonly at: number;
  readonly userId: string | null;
  readonly guildId: string;
  /** False for rows that were abandoned: they break chains rather than joining them. */
  readonly played: boolean;
  /** A person chose it, or autoplay did. Autoplay's own adjacencies count less. */
  readonly chosen: boolean;
}

export class CooccurrenceService {
  readonly #prisma: PrismaClient;
  readonly #cache: CacheService;

  constructor(prisma: PrismaClient, cache: CacheService) {
    this.#prisma = prisma;
    this.#cache = cache;
  }

  /**
   * The co-occurrence graphs for this room.
   *
   * A failure returns empty signals rather than throwing: behavioural
   * similarity is one term of a blend, and losing it must degrade the ranking,
   * not stop the music.
   *
   * @param guildId - Discord snowflake, not the internal Guild row id.
   * @param listenerIds - Discord ids of the people currently driving the queue.
   */
  async signals(guildId: string, listenerIds: readonly string[]): Promise<CooccurrenceSignals> {
    // Sorted so the same set of listeners in a different order is one cache
    // entry, not two.
    const key = `cooc:${guildId}:${[...listenerIds].sort().join(',')}`;

    const cached = await this.#cache.get<CachedSignals>(key);
    if (cached !== null) return rehydrate(cached);

    try {
      const [history, playlists, favorites] = await Promise.all([
        this.#loadHistory(guildId),
        this.#loadPlaylists(guildId, listenerIds),
        this.#loadFavorites(listenerIds),
      ]);

      const pairs = new PairGraph();
      const plays = toPlays(history);
      // Adjacency runs first: the same-session pass needs to know which pairs
      // already earned the stronger weight.
      foldAdjacency(pairs, plays);
      foldSameDay(pairs, plays);
      foldPlaylists(pairs, playlists);
      foldFavorites(pairs, favorites);

      const signals = pairs.finalise();
      await this.#cache.set(key, dehydrate(signals), SIGNALS_CACHE_TTL_MS);
      return signals;
    } catch (error) {
      logger.warn(
        { err: error, guildId, listeners: listenerIds.length },
        'Co-occurrence signals failed',
      );
      return EMPTY_SIGNALS;
    }
  }

  /**
   * What has been played IN THIS GUILD.
   *
   * Co-occurrence is a claim about a room: these two songs were heard
   * together, here. A listener's play in another server sat next to that
   * server's music, so it says nothing about what fits next in this one —
   * and folding it in was how one guild's pairs seeded another's radio.
   * `guildId` stays selected: `foldAdjacency` groups by it, and one query
   * answering for one guild should still be provably so.
   */
  async #loadHistory(guildId: string): Promise<readonly HistoryRow[]> {
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000);

    return this.#prisma.songHistory.findMany({
      where: {
        playedAt: { gte: since },
        guild: { discordId: guildId },
      },
      orderBy: { playedAt: 'desc' },
      take: HISTORY_MAX_ROWS,
      select: {
        identifier: true,
        title: true,
        author: true,
        playedMs: true,
        durationMs: true,
        skipped: true,
        origin: true,
        playedAt: true,
        userId: true,
        guildId: true,
      },
    });
  }

  /**
   * The listeners' own playlists plus the ones shared with this server. The
   * guild clause goes through the relation: `Playlist.guildId` is the internal
   * Guild row id, not the snowflake the caller passes in.
   */
  async #loadPlaylists(
    guildId: string,
    listenerIds: readonly string[],
  ): Promise<readonly PlaylistRow[]> {
    const owned =
      listenerIds.length === 0 ? [] : [{ owner: { discordId: { in: [...listenerIds] } } }];

    return this.#prisma.playlist.findMany({
      where: {
        OR: [...owned, { guild: { discordId: guildId }, visibility: PlaylistVisibility.PUBLIC }],
      },
      orderBy: [{ favorite: 'desc' }, { playCount: 'desc' }, { updatedAt: 'desc' }],
      take: PLAYLISTS_MAX,
      select: {
        tracks: {
          orderBy: { position: 'asc' },
          take: PLAYLIST_TRACKS_MAX,
          select: { title: true, author: true },
        },
      },
    });
  }

  /** Saved tracks, kept in save order so "saved in the same sitting" survives. */
  async #loadFavorites(listenerIds: readonly string[]): Promise<readonly FavoriteRow[]> {
    if (listenerIds.length === 0) return [];

    return this.#prisma.favoriteTrack.findMany({
      where: { user: { discordId: { in: [...listenerIds] } } },
      orderBy: { createdAt: 'desc' },
      take: FAVORITES_MAX_ROWS,
      select: {
        title: true,
        author: true,
        user: { select: { discordId: true } },
      },
    });
  }
}

/**
 * How related two songs are, 0..1, from behaviour alone.
 *
 * Symmetric by taking the better of the two directed edges: normalisation is
 * per row, so a nightly anthem is a weak neighbour of the obscure track it
 * follows while that track is the anthem's strongest neighbour. Both readings
 * are true; the stronger one is the one that carries information.
 */
export function similarityBetween(
  signals: CooccurrenceSignals,
  keyA: string,
  keyB: string,
): number {
  return edgeBetween(signals.tracks, keyA, keyB);
}

/**
 * How well a candidate fits the neighbourhood of a set of seeds, 0..1.
 *
 * The artist term exists because the track graph is sparse: a song the room has
 * never played has no edges at all and would score zero however obviously it
 * belongs, while its artist usually does have edges. Tracks dominate the blend
 * because a track edge is the specific claim and an artist edge the general one.
 */
export function neighbourhoodScore(
  signals: CooccurrenceSignals,
  candidateKey: string,
  candidateArtistKey: string,
  seedKeys: readonly string[],
  seedArtistKeys: readonly string[],
): number {
  let track = 0;
  for (const seed of seedKeys) {
    track = Math.max(track, edgeBetween(signals.tracks, candidateKey, seed));
  }

  let artist = 0;
  for (const seed of seedArtistKeys) {
    artist = Math.max(artist, edgeBetween(signals.artists, candidateArtistKey, seed));
  }

  return clamp01(TRACK_TERM_WEIGHT * track + ARTIST_TERM_WEIGHT * artist);
}

/** Accumulates raw pair weights, then hands back the normalised graphs. */
class PairGraph {
  readonly #tracks = new Map<string, Map<string, number>>();
  readonly #artists = new Map<string, Map<string, number>>();
  /** Pairs that already earned adjacency, so the same-day pass leaves them alone. */
  readonly #adjacent = new Set<string>();

  /** Record one piece of evidence for an unordered pair; a self-pair is not evidence. */
  add(a: Entry, b: Entry, weight: number): void {
    if (a.key !== b.key) {
      bump(this.#tracks, a.key, b.key, weight);
      bump(this.#tracks, b.key, a.key, weight);
    }
    // An artist appearing next to themselves is the normal case (an album, a
    // two-song run) and says nothing about which artists go together.
    if (a.artistKey !== b.artistKey && a.artistKey.length > 0 && b.artistKey.length > 0) {
      bump(this.#artists, a.artistKey, b.artistKey, weight);
      bump(this.#artists, b.artistKey, a.artistKey, weight);
    }
  }

  markAdjacent(a: Entry, b: Entry): void {
    this.#adjacent.add(pairId(a.key, b.key));
  }

  isAdjacent(a: Entry, b: Entry): boolean {
    return this.#adjacent.has(pairId(a.key, b.key));
  }

  finalise(): CooccurrenceSignals {
    return { tracks: normalise(this.#tracks), artists: normalise(this.#artists) };
  }
}

/** Consecutive plays in one guild, inside the adjacency window. */
function foldAdjacency(pairs: PairGraph, plays: readonly Play[]): void {
  for (const guildPlays of groupBy(plays, (play) => play.guildId)) {
    let previous: Play | null = null;
    for (const play of guildPlays) {
      if (!play.played) {
        // The abandoned row is not removed from the sequence, it severs it:
        // whatever came before and after it were never heard together.
        previous = null;
        continue;
      }
      if (previous !== null && play.at - previous.at <= ADJACENCY_WINDOW_MS) {
        // Two songs a person put on back to back is taste; two autoplay
        // picks in a row is the recommender agreeing with itself, and
        // weighting them equally would let it learn from its own output.
        const chosen = Number(previous.chosen) + Number(play.chosen);
        const weight =
          chosen === 2
            ? WEIGHT_ADJACENT
            : chosen === 1
              ? WEIGHT_ADJACENT_MIXED
              : WEIGHT_ADJACENT_AUTOPLAY;
        pairs.add(previous.entry, play.entry, weight);
        pairs.markAdjacent(previous.entry, play.entry);
      }
      previous = play;
    }
  }
}

/** The same person, both songs inside a day, not already counted as adjacent. */
function foldSameDay(pairs: PairGraph, plays: readonly Play[]): void {
  const identified = plays.filter(
    (play): play is Play & { userId: string } => play.played && play.userId !== null,
  );

  for (const userPlays of groupBy(identified, (play) => play.userId)) {
    for (let i = 0; i < userPlays.length; i += 1) {
      const first = userPlays[i];
      if (first === undefined) continue;
      const end = Math.min(userPlays.length, i + 1 + NEIGHBOUR_WINDOW);
      for (let j = i + 1; j < end; j += 1) {
        const second = userPlays[j];
        if (second === undefined) continue;
        // Ascending time order, so once the gap is too wide it only widens.
        if (second.at - first.at > SAME_DAY_WINDOW_MS) break;
        if (pairs.isAdjacent(first.entry, second.entry)) continue;
        pairs.add(first.entry, second.entry, WEIGHT_SAME_DAY);
      }
    }
  }
}

function foldPlaylists(pairs: PairGraph, playlists: readonly PlaylistRow[]): void {
  for (const playlist of playlists) {
    windowPairs(pairs, playlist.tracks.map(entryOf), WEIGHT_PLAYLIST);
  }
}

function foldFavorites(pairs: PairGraph, favorites: readonly FavoriteRow[]): void {
  const owned = favorites.filter(
    (row): row is FavoriteRow & { user: { discordId: string } } => row.user !== null,
  );

  for (const userFavorites of groupBy(owned, (row) => row.user.discordId)) {
    if (userFavorites.length > FAVORITES_PER_USER_MAX) continue;
    windowPairs(pairs, userFavorites.map(entryOf), WEIGHT_FAVORITE);
  }
}

/** Pair each entry with the next `NEIGHBOUR_WINDOW` entries of an ordered list. */
function windowPairs(pairs: PairGraph, entries: readonly Entry[], weight: number): void {
  for (let i = 0; i < entries.length; i += 1) {
    const first = entries[i];
    if (first === undefined) continue;
    const end = Math.min(entries.length, i + 1 + NEIGHBOUR_WINDOW);
    for (let j = i + 1; j < end; j += 1) {
      const second = entries[j];
      if (second === undefined) continue;
      pairs.add(first, second, weight);
    }
  }
}

/** History rows as plays in ascending time order - the order every walk needs. */
function toPlays(rows: readonly HistoryRow[]): readonly Play[] {
  return rows
    .map((row) => ({
      entry: entryOf(row),
      at: row.playedAt.getTime(),
      userId: row.userId,
      guildId: row.guildId,
      // `skipped` is deliberately not consulted: a stream that died ten seconds
      // in is never flagged skipped and is just as much a non-play, while
      // skipping the last few seconds of a song is not a rejection at all. The
      // completion ratio answers both cases; the flag answers neither.
      played: completionOf(row) >= MIN_COMPLETION,
      chosen: row.origin !== 'autoplay',
    }))
    .sort((a, b) => a.at - b.at);
}

function entryOf(row: { readonly title: string; readonly author: string }): Entry {
  const identity = identityOf(row.author, row.title);
  return { key: identity.key, artistKey: identity.artistKey };
}

function completionOf(row: { readonly playedMs: number; readonly durationMs: number }): number {
  if (row.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, row.playedMs / row.durationMs));
}

function bump(graph: Map<string, Map<string, number>>, from: string, to: string, by: number): void {
  const row = graph.get(from) ?? new Map<string, number>();
  row.set(to, (row.get(to) ?? 0) + by);
  graph.set(from, row);
}

/**
 * Scale every row so its strongest neighbour is 1, keeping only the strongest
 * few. Weights then read as "how central is this neighbour to *this* song"
 * rather than "how much listening happened at all".
 */
function normalise(
  graph: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  // Rows are capped by the strength of their best RAW edge before any
  // per-row normalisation: normalised rows all peak at 1, so ranking after
  // would be meaningless, and an uncapped graph over a heavy guild is
  // megabytes of JSON churned into the cache every ten minutes.
  const rows = [...graph.entries()]
    .map(([key, neighbours]) => {
      const ranked = [...neighbours].sort((a, b) => b[1] - a[1]).slice(0, MAX_NEIGHBOURS);
      return { key, ranked, strongest: ranked[0]?.[1] ?? 0 };
    })
    .filter((row) => row.strongest > 0)
    .sort((a, b) => b.strongest - a.strongest)
    .slice(0, MAX_ROWS);

  const result = new Map<string, ReadonlyMap<string, number>>();
  for (const { key, ranked, strongest } of rows) {
    result.set(key, new Map(ranked.map(([neighbour, weight]) => [neighbour, weight / strongest])));
  }
  return result;
}

/** The better of the two directed edges between `a` and `b`, or 0. */
function edgeBetween(
  graph: ReadonlyMap<string, ReadonlyMap<string, number>>,
  a: string,
  b: string,
): number {
  return Math.max(graph.get(a)?.get(b) ?? 0, graph.get(b)?.get(a) ?? 0);
}

/**
 * Stable id for an unordered pair. Length-prefixed because track keys contain
 * every separator worth choosing, and "a" + "b::c" must not collide with
 * "a::b" + "c".
 */
function pairId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${String(first.length)}:${first}${second}`;
}

/** Group, preserving the input order inside each group. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function dehydrate(signals: CooccurrenceSignals): CachedSignals {
  return { tracks: rowsOf(signals.tracks), artists: rowsOf(signals.artists) };
}

function rowsOf(graph: ReadonlyMap<string, ReadonlyMap<string, number>>): readonly CachedRow[] {
  return [...graph].map(([key, neighbours]) => [key, [...neighbours]] as const);
}

function rehydrate(cached: CachedSignals): CooccurrenceSignals {
  return { tracks: graphOf(cached.tracks), artists: graphOf(cached.artists) };
}

function graphOf(rows: readonly CachedRow[]): ReadonlyMap<string, ReadonlyMap<string, number>> {
  return new Map(rows.map(([key, neighbours]) => [key, new Map(neighbours)]));
}

interface HistoryRow {
  readonly identifier: string;
  readonly title: string;
  readonly author: string;
  readonly playedMs: number;
  readonly durationMs: number;
  readonly skipped: boolean;
  readonly origin: string;
  readonly playedAt: Date;
  readonly userId: string | null;
  readonly guildId: string;
}

interface PlaylistRow {
  readonly tracks: readonly { readonly title: string; readonly author: string }[];
}

interface FavoriteRow {
  readonly title: string;
  readonly author: string;
  readonly user: { readonly discordId: string } | null;
}
