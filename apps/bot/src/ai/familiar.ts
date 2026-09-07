/**
 * The familiar pool — the songs this room already knows.
 *
 * Autoplay used to have exactly one idea of what to play next: something
 * *similar* to the current track. That is a fine way to fill a queue and a poor
 * way to run a radio, because the one thing a listener reliably wants is their
 * own music back. Everything needed for that is already in the database and
 * none of it was being read: saved favorites, playlists (their own and the ones
 * shared with the server), and the guild's own play history.
 *
 * This service is the read side of that. It answers one question — "what does
 * this room already know and like?" — as a flat list of candidates with the
 * behavioural evidence attached (plays, completions, early skips, who owns it,
 * when it was last heard). Deciding which of them to actually play is the
 * scorer's job; this module only gathers and merges.
 *
 * Three merge rules carry most of the weight:
 *
 * A song is one song. The same track arrives as a favorite, as a playlist entry
 * and as a dozen history rows under three different provider titles, so
 * everything is folded onto `identityOf(artist, title).key` and the sources are
 * unioned. A favourite that also gets played constantly should outrank a
 * favourite that never does, and it only can if both facts land on one row.
 *
 * History alone is weak evidence. A single autoplay play the listener neither
 * asked for nor sat through says nothing except that the recommender once
 * guessed it — treating that as "familiar" would let autoplay launder its own
 * output back in as taste. So history only makes a song familiar once somebody
 * chose it, finished it, or came back to it.
 *
 * Metadata comes from the most authoritative place it appears. A library or
 * playlist row was curated by a person; a history row is whatever string the
 * provider happened to return that night.
 */
import {
  MusicSource as DbMusicSource,
  PlaylistVisibility,
  type PrismaClient,
} from '@discord-music/database';
import type { MusicSource } from '@discord-music/shared';

import { getLogger } from '../lib/logger.js';

import type { CacheService } from './cache.js';
import type { FamiliarCandidate, FamiliarSource } from './familiar-scoring.js';
import { identityOf } from './identity.js';
import type { SpotifyTasteService, SpotifyTasteTrack } from './spotify-taste.js';

const logger = getLogger('familiar-pool');

/**
 * Short enough that a track finishing changes the pool on the next generation,
 * long enough that a busy queue does not re-run four queries per song.
 */
const POOL_CACHE_TTL_MS = 2 * 60_000;

/** Every query is bounded — a guild with two years of history must not stall autoplay. */
const HISTORY_WINDOW_DAYS = 120;
const HISTORY_MAX_ROWS = 1_000;
const FAVORITES_MAX_ROWS = 300;
const PLAYLISTS_MAX = 12;
const PLAYLIST_TRACKS_MAX = 100;
const MAX_CANDIDATES = 400;

/**
 * How recently a person must have asked for a song for it to count as
 * "requested" rather than merely "in the history". A week covers the sessions
 * this room is likely still in the middle of; older explicit plays remain
 * history and are ranked by their replay and completion evidence instead.
 */
const REQUESTED_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Uploader-channel decorations that history rows written from a raw
 * YouTube result carry in the artist field. "Artist - Topic" is not an
 * artist, and searching for it — or crediting it in the queue — is wrong.
 */
const CHANNEL_SUFFIXES = /\s*(?:-\s*Topic|VEVO)\s*$/iu;

/** Mirrors autoplay's own bounds: podcasts, sets and streams are not radio material. */
const MAX_DURATION_MS = 15 * 60_000;

/** A play this complete is an endorsement; below the early-skip line it is a rejection. */
const COMPLETION_THRESHOLD = 0.85;
const EARLY_SKIP_THRESHOLD = 0.5;

/** Playlists get relevance from being starred and from being played. */
const PLAYLIST_PLAYCOUNT_FULL = 10;

/**
 * The stored enum is not the shared lowercase union the rest of the bot speaks.
 * Replicated locally rather than imported so this module owns no dependency on
 * the command-layer services.
 */
const FROM_DB_SOURCE: Record<DbMusicSource, MusicSource> = {
  [DbMusicSource.YOUTUBE]: 'youtube',
  [DbMusicSource.SPOTIFY]: 'spotify',
  [DbMusicSource.SOUNDCLOUD]: 'soundcloud',
  [DbMusicSource.DEEZER]: 'deezer',
};

/**
 * How authoritative a row's metadata is. Higher wins. Ranks are spaced so a
 * row from a metadata catalogue (Spotify, Deezer — clean canonical strings)
 * can outrank a playback-provider row of the same tier, whose title is
 * whatever the upload was called.
 */
const METADATA_RANK: Readonly<Record<FamiliarSource, number>> = {
  requested: 8,
  library: 6,
  // Above a local playlist row: Spotify's strings are the catalogue's own, so
  // when the same song arrives from both, Spotify's spelling of the title and
  // artist is the one worth keeping.
  spotify: 5,
  playlist: 4,
  history: 2,
};

function metadataRankOf(source: FamiliarSource, row: RowMetadata): number {
  const catalogue = row.source === DbMusicSource.SPOTIFY || row.source === DbMusicSource.DEEZER;
  return METADATA_RANK[source] + (catalogue ? 1 : 0);
}

/**
 * The cached form of a candidate.
 *
 * `sources` is a Set, and a Set JSON-round-trips to `{}` — so the Redis tier
 * would silently hand back candidates with no sources at all, which the scorer
 * reads as "not familiar". Serialising it as an array and rehydrating on read
 * keeps the memory and Redis tiers returning the same thing.
 */
interface CachedCandidate extends Omit<FamiliarCandidate, 'sources'> {
  readonly sources: readonly FamiliarSource[];
}

/** Mutable accumulator; one per canonical song, converted to a candidate at the end. */
interface Draft {
  title: string;
  artist: string;
  durationMs: number;
  uri: string | null;
  identifier: string;
  source: MusicSource;
  artworkUrl: string | null;
  metadataRank: number;
  readonly sources: Set<FamiliarSource>;
  plays: number;
  userPlays: number;
  completions: number;
  earlySkips: number;
  lastPlayedAt: number | null;
  playlistRelevance: number;
  /** Distinct owners seen for this song; sized, never read out. */
  readonly listeners: Set<string>;
}

/** The metadata half of a row, shared by all three sources. */
interface RowMetadata {
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly uri: string | null;
  readonly identifier: string;
  readonly source: DbMusicSource;
  readonly artworkUrl: string | null;
}

export class FamiliarPoolService {
  readonly #prisma: PrismaClient;
  readonly #cache: CacheService;
  readonly #spotifyTaste: SpotifyTasteService | undefined;

  constructor(prisma: PrismaClient, cache: CacheService, spotifyTaste?: SpotifyTasteService) {
    this.#prisma = prisma;
    this.#cache = cache;
    this.#spotifyTaste = spotifyTaste;
  }

  /**
   * Everything this guild and these listeners already know, merged.
   *
   * Order is not meaningful — the scorer ranks. A failure returns an empty pool
   * rather than throwing: autoplay then falls back to discovery alone, which is
   * a worse radio but still a radio.
   *
   * @param guildId - Discord snowflake, not the internal Guild row id.
   * @param listenerIds - Discord ids of the people currently driving the queue.
   */
  async pool(
    guildId: string,
    listenerIds: readonly string[],
  ): Promise<readonly FamiliarCandidate[]> {
    // Sorted so the same set of listeners in a different order is one cache
    // entry, not two.
    const key = `familiar:${guildId}:${[...listenerIds].sort().join(',')}`;

    const cached = await this.#cache.get<readonly CachedCandidate[]>(key);
    if (cached !== null) {
      return cached.map((candidate) => ({ ...candidate, sources: new Set(candidate.sources) }));
    }

    try {
      const [favorites, playlists, history, spotify] = await Promise.all([
        this.#loadFavorites(listenerIds),
        this.#loadPlaylists(guildId, listenerIds),
        this.#loadHistory(guildId),
        this.#loadSpotify(listenerIds),
      ]);

      const drafts = new Map<string, Draft>();
      this.#foldFavorites(drafts, favorites);
      this.#foldPlaylists(drafts, playlists);
      this.#foldHistory(drafts, history);
      this.#foldSpotify(drafts, spotify);

      const candidates = finalise(drafts);
      await this.#cache.set(
        key,
        candidates.map((candidate) => ({ ...candidate, sources: [...candidate.sources] })),
        POOL_CACHE_TTL_MS,
      );
      return candidates;
    } catch (error) {
      logger.warn({ err: error, guildId, listeners: listenerIds.length }, 'Familiar pool failed');
      return [];
    }
  }

  /**
   * What the room's linked Spotify accounts hold.
   *
   * Cache-only and never throws — see `SpotifyTasteService`. Absent service,
   * disabled feature, cold cache and API failure are all the same thing here:
   * no rows, and a pool built from the other three sources exactly as before.
   */
  async #loadSpotify(listenerIds: readonly string[]): Promise<readonly SpotifyTasteTrack[]> {
    if (this.#spotifyTaste === undefined) return [];
    return this.#spotifyTaste.tracksFor(listenerIds).catch(() => []);
  }

  #foldSpotify(drafts: Map<string, Draft>, rows: readonly SpotifyTasteTrack[]): void {
    for (const row of rows) {
      const draft = upsertDraft(drafts, row, 'spotify');
      if (draft === null) continue;
      draft.sources.add('spotify');
      draft.listeners.add(row.ownerId);
    }
  }

  /** Saved tracks of the people in the room. The strongest "they like this" there is. */
  async #loadFavorites(listenerIds: readonly string[]): Promise<readonly FavoriteRow[]> {
    if (listenerIds.length === 0) return [];
    return this.#prisma.favoriteTrack.findMany({
      where: { user: { discordId: { in: [...listenerIds] } } },
      orderBy: { createdAt: 'desc' },
      take: FAVORITES_MAX_ROWS,
      select: {
        identifier: true,
        title: true,
        author: true,
        durationMs: true,
        uri: true,
        source: true,
        artworkUrl: true,
        user: { select: { discordId: true } },
      },
    });
  }

  /**
   * The listeners' own playlists plus the ones shared with this server.
   *
   * Tracks come back nested rather than in a second round trip. Note the guild
   * clause goes through the relation: `Playlist.guildId` is the internal Guild
   * row id, not the snowflake the caller passes in.
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
        favorite: true,
        playCount: true,
        owner: { select: { discordId: true } },
        tracks: {
          orderBy: { position: 'asc' },
          take: PLAYLIST_TRACKS_MAX,
          select: {
            identifier: true,
            title: true,
            author: true,
            durationMs: true,
            uri: true,
            source: true,
            artworkUrl: true,
          },
        },
      },
    });
  }

  /**
   * What has actually been played IN THIS GUILD.
   *
   * Strictly one server's plays. This used to widen to "or by these listeners
   * anywhere", on the reasoning that a person's history in another server is
   * still their taste — but a play is also an event that happened in a room,
   * and pulling one server's plays into another's pool is what made a song
   * queued in one guild turn up unprompted in the next. Taste that genuinely
   * travels with a person still reaches the pool through their favourites and
   * playlists below, which are library, not room activity.
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
        durationMs: true,
        uri: true,
        source: true,
        playedMs: true,
        skipped: true,
        origin: true,
        playedAt: true,
        userId: true,
      },
    });
  }

  #foldFavorites(drafts: Map<string, Draft>, rows: readonly FavoriteRow[]): void {
    for (const row of rows) {
      const draft = upsertDraft(drafts, row, 'library');
      if (draft === null) continue;
      draft.sources.add('library');
      const owner = row.user?.discordId;
      if (owner !== undefined) draft.listeners.add(owner);
    }
  }

  #foldPlaylists(drafts: Map<string, Draft>, playlists: readonly PlaylistRow[]): void {
    for (const playlist of playlists) {
      const relevance =
        (playlist.favorite ? 0.5 : 0) +
        0.5 * Math.min(1, playlist.playCount / PLAYLIST_PLAYCOUNT_FULL);
      const owner = playlist.owner?.discordId;

      for (const row of playlist.tracks) {
        const draft = upsertDraft(drafts, row, 'playlist');
        if (draft === null) continue;
        draft.sources.add('playlist');
        // A song in two playlists takes the better one — being in someone's
        // most-played list is not cancelled out by also being in a dead one.
        draft.playlistRelevance = Math.max(draft.playlistRelevance, relevance);
        if (owner !== undefined) draft.listeners.add(owner);
      }
    }
  }

  /**
   * History contributes its statistics to every song, but only *earns* the
   * 'history' source once the evidence is real — see `finalise`.
   */
  #foldHistory(drafts: Map<string, Draft>, rows: readonly HistoryRow[]): void {
    const requestedSince = Date.now() - REQUESTED_WINDOW_MS;
    for (const row of rows) {
      const draft = upsertDraft(drafts, { ...row, artworkUrl: null }, 'history');
      if (draft === null) continue;

      const completion = completionOf(row);
      draft.plays += 1;
      if (row.origin !== 'autoplay') {
        draft.userPlays += 1;
        // Somebody typed this in recently: the strongest claim a song can
        // have on the room, and the one the plan calls "requested".
        if (row.playedAt.getTime() >= requestedSince) draft.sources.add('requested');
      }
      if (completion >= COMPLETION_THRESHOLD) draft.completions += 1;
      if (row.skipped && completion < EARLY_SKIP_THRESHOLD) draft.earlySkips += 1;

      const playedAt = row.playedAt.getTime();
      if (draft.lastPlayedAt === null || playedAt > draft.lastPlayedAt) {
        draft.lastPlayedAt = playedAt;
      }

      // History rows carry the internal User row id rather than the snowflake
      // the other two sources use. Both are stable per person, so the count is
      // right whenever a listener reaches a song through one source; someone
      // who both saved and played a song can be counted twice. That over-counts
      // in the listener's favour, which is the harmless direction.
      if (row.userId !== null) draft.listeners.add(row.userId);
    }
  }
}

/**
 * Find or create the draft for a row, applying the metadata precedence.
 *
 * Returns null when the row is not radio material at all: too long, or a
 * live stream masquerading as a track (no duration and no address).
 */
function upsertDraft(
  drafts: Map<string, Draft>,
  row: RowMetadata,
  source: FamiliarSource,
): Draft | null {
  if (row.durationMs > MAX_DURATION_MS) return null;
  if (row.durationMs <= 0 && (row.uri === null || row.uri.length === 0)) return null;

  const key = identityOf(row.author, row.title).key;
  const existing = drafts.get(key);
  const rank = metadataRankOf(source, row);
  const artist = row.author.replace(CHANNEL_SUFFIXES, '').trim() || row.author;

  if (existing === undefined) {
    const draft: Draft = {
      title: row.title,
      artist,
      durationMs: Math.max(0, row.durationMs),
      uri: row.uri,
      identifier: row.identifier,
      source: FROM_DB_SOURCE[row.source],
      artworkUrl: row.artworkUrl,
      metadataRank: rank,
      sources: new Set<FamiliarSource>(),
      plays: 0,
      userPlays: 0,
      completions: 0,
      earlySkips: 0,
      lastPlayedAt: null,
      playlistRelevance: 0,
      listeners: new Set<string>(),
    };
    drafts.set(key, draft);
    return draft;
  }

  // Sources are folded library → playlist → history and rows arrive newest
  // first, so a strict improvement is the only case that should overwrite: the
  // first row of the best-ranked source wins.
  if (rank > existing.metadataRank) {
    existing.title = row.title;
    existing.artist = artist;
    existing.durationMs = Math.max(0, row.durationMs);
    existing.uri = row.uri;
    existing.identifier = row.identifier;
    existing.source = FROM_DB_SOURCE[row.source];
    existing.artworkUrl = row.artworkUrl;
    existing.metadataRank = rank;
  } else if (existing.durationMs === 0 && row.durationMs > 0) {
    // A known duration is worth taking from a weaker source: it is what lets
    // the resolver match the right upload rather than a random one.
    existing.durationMs = row.durationMs;
  }

  return existing;
}

/**
 * Turn the drafts into candidates: decide which history entries count as
 * familiar, drop everything with no source left, and cap the pool.
 */
function finalise(drafts: Map<string, Draft>): readonly FamiliarCandidate[] {
  const candidates: FamiliarCandidate[] = [];

  for (const draft of drafts.values()) {
    // One autoplay play nobody asked for and nobody finished is not
    // familiarity — it is the recommender's own guess coming back around.
    // Two plays only count when neither was rejected: autoplay's own
    // twice-skipped pick must not launder itself into the familiar pool.
    const historyIsEvidence =
      draft.userPlays >= 1 ||
      draft.completions >= 1 ||
      (draft.plays >= 2 && draft.earlySkips === 0);
    if (draft.plays > 0 && historyIsEvidence) draft.sources.add('history');
    if (draft.sources.size === 0) continue;

    candidates.push({
      title: draft.title,
      artist: draft.artist,
      durationMs: draft.durationMs,
      uri: draft.uri,
      identifier: draft.identifier,
      source: draft.source,
      artworkUrl: draft.artworkUrl,
      sources: draft.sources,
      plays: draft.plays,
      userPlays: draft.userPlays,
      completions: draft.completions,
      earlySkips: draft.earlySkips,
      lastPlayedAt: draft.lastPlayedAt,
      playlistRelevance: draft.playlistRelevance,
      listenerCount: draft.listeners.size,
    });
  }

  if (candidates.length <= MAX_CANDIDATES) return candidates;

  // Corroboration first, then sheer repetition: a song that is saved *and*
  // playlisted *and* played is the last thing that should fall off the end.
  return candidates
    .sort((a, b) => b.sources.size - a.sources.size || b.plays - a.plays)
    .slice(0, MAX_CANDIDATES);
}

function completionOf(row: { readonly playedMs: number; readonly durationMs: number }): number {
  if (row.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, row.playedMs / row.durationMs));
}

interface FavoriteRow extends RowMetadata {
  readonly user: { readonly discordId: string } | null;
}

interface PlaylistRow {
  readonly favorite: boolean;
  readonly playCount: number;
  readonly owner: { readonly discordId: string } | null;
  readonly tracks: readonly RowMetadata[];
}

interface HistoryRow extends Omit<RowMetadata, 'artworkUrl'> {
  readonly playedMs: number;
  readonly skipped: boolean;
  readonly origin: string;
  readonly playedAt: Date;
  readonly userId: string | null;
}
