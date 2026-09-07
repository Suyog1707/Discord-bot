/**
 * What the people in this channel actually listen to, according to Spotify.
 *
 * The familiar pool already reads everything the bot itself knows about a
 * listener — what they favourited here, the playlists they built here, what
 * this guild has played. For most people that is a thin shadow of their real
 * taste, which lives in an account they linked to the dashboard and which the
 * bot only ever used to resolve `/play` URLs.
 *
 * This service turns that account into familiar-pool rows: their playlists and
 * Liked Songs, folded per person, ready for `FamiliarPoolService` to merge onto
 * the same canonical keys as everything else. The songs stay *familiar* — they
 * are things the listener already chose — and the artists behind them are also
 * offered to the planner as a taste signal, which is what makes discovery pick
 * up on a Spotify habit the bot has never seen played here.
 *
 * Two rules shape the whole design:
 *
 * **Spotify is never on the critical path.** Autoplay generates while a song is
 * playing and has seconds, not the time it takes to page through somebody's
 * library. A cache miss therefore returns nothing at all and refreshes in the
 * background; the pool is simply un-Spotified for one generation and correct
 * from the next. Blocking a refill on a third party would be a worse trade than
 * a slightly duller first batch.
 *
 * **Consent is per person.** Only listeners who linked Spotify *and* left the
 * autoplay opt-in on are read. Everyone else contributes nothing and costs
 * nothing.
 */
import { MusicSource as DbMusicSource, type PrismaClient } from '@discord-music/database';

import { getLogger } from '../lib/logger.js';
import type { SpotifyService, UserPlaylist, UserTrack } from '../services/spotify-service.js';

import type { CacheService } from './cache.js';
import { identityOf } from './identity.js';

const logger = getLogger('spotify-taste');

/**
 * Long, because a person's Spotify library is not a fast-moving thing and
 * every miss costs a fan-out of paged API calls. A playlist edited mid-session
 * showing up half an hour later is not a problem worth paying for.
 */
const CACHE_TTL_MS = 30 * 60_000;

/** Playlists read per listener, most recently touched first. */
const PLAYLISTS_PER_LISTENER = 6;
/** Tracks read from any single playlist. */
const TRACKS_PER_PLAYLIST = 100;
/** Hard ceiling per listener, whatever the playlist count. */
const TRACKS_PER_LISTENER = 200;

/**
 * A Spotify track in the shape the familiar pool folds.
 *
 * Structurally the pool's own row metadata plus who it belongs to; kept as its
 * own type so this module does not reach into `familiar.ts` internals.
 */
export interface SpotifyTasteTrack {
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly uri: string | null;
  readonly identifier: string;
  readonly source: DbMusicSource;
  readonly artworkUrl: string | null;
  /** Discord snowflake of the listener whose library this came from. */
  readonly ownerId: string;
}

export interface SpotifyTasteOptions {
  readonly spotify: SpotifyService;
  readonly cache: CacheService;
  readonly prisma: PrismaClient;
  /** Master switch; false makes every read a no-op. */
  readonly enabled?: boolean;
  readonly maxTracksPerListener?: number;
}

export class SpotifyTasteService {
  readonly #spotify: SpotifyService;
  readonly #cache: CacheService;
  readonly #prisma: PrismaClient;
  readonly #enabled: boolean;
  readonly #maxTracks: number;

  /** One warm-up per listener at a time; a busy guild must not fan out. */
  readonly #inFlight = new Set<string>();

  constructor(options: SpotifyTasteOptions) {
    this.#spotify = options.spotify;
    this.#cache = options.cache;
    this.#prisma = options.prisma;
    this.#enabled = options.enabled ?? true;
    this.#maxTracks = options.maxTracksPerListener ?? TRACKS_PER_LISTENER;
  }

  get enabled(): boolean {
    return this.#enabled && this.#spotify.canReadTokens();
  }

  /**
   * Spotify tracks for these listeners, from cache only.
   *
   * A listener whose entry is cold contributes nothing this time and is warmed
   * in the background — see the note on the class about staying off the
   * critical path. Never throws.
   */
  async tracksFor(listenerIds: readonly string[]): Promise<readonly SpotifyTasteTrack[]> {
    if (!this.enabled || listenerIds.length === 0) return [];

    const collected: SpotifyTasteTrack[] = [];
    await Promise.all(
      listenerIds.map(async (discordId) => {
        const cached = await this.#cache
          .get<readonly SpotifyTasteTrack[]>(cacheKey(discordId))
          .catch(() => null);

        if (cached === null) {
          this.#warm(discordId);
          return;
        }
        collected.push(...cached);
      }),
    );
    return collected;
  }

  /**
   * Artist affinity in [0, 1] from the same cached libraries.
   *
   * Normalised against the most-saved artist so one listener with a thousand
   * tracks cannot outvote the rest of the room, and offered to the planner as a
   * prior — this is the half of the feature that reaches *discovery*, because
   * the recommender already seeds new music from top-affinity artists.
   */
  async artistAffinity(listenerIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const tracks = await this.tracksFor(listenerIds);
    if (tracks.length === 0) return new Map();

    const counts = new Map<string, number>();
    for (const track of tracks) {
      const artistKey = identityOf(track.author, track.title).artistKey;
      if (artistKey === '') continue;
      counts.set(artistKey, (counts.get(artistKey) ?? 0) + 1);
    }

    let peak = 0;
    for (const count of counts.values()) if (count > peak) peak = count;
    if (peak === 0) return new Map();

    const affinity = new Map<string, number>();
    for (const [artistKey, count] of counts) affinity.set(artistKey, count / peak);
    return affinity;
  }

  /** Refresh one listener's library in the background, at most once at a time. */
  #warm(discordId: string): void {
    if (this.#inFlight.has(discordId)) return;
    this.#inFlight.add(discordId);

    void this.#load(discordId)
      .then(async (tracks) =>
        // Cache the empty result too: a listener with no Spotify must not be
        // re-checked on every single generation pass.
        this.#cache.set(cacheKey(discordId), tracks, CACHE_TTL_MS),
      )
      .catch((error: unknown) => {
        logger.debug({ err: error, discordId }, 'Spotify taste warm-up failed');
      })
      .finally(() => {
        this.#inFlight.delete(discordId);
      });
  }

  async #load(discordId: string): Promise<readonly SpotifyTasteTrack[]> {
    const account = await this.#prisma.spotifyAccount.findFirst({
      where: { user: { discordId } },
      select: { autoplayOptIn: true },
    });
    // Not linked, or linked but opted out of steering a shared room.
    if (account?.autoplayOptIn !== true) return [];

    const playlists = await this.#spotify.listPlaylists(discordId);
    const chosen = playlists.slice(0, PLAYLISTS_PER_LISTENER);

    const collected: SpotifyTasteTrack[] = [];
    const seen = new Set<string>();

    for (const playlist of chosen) {
      if (collected.length >= this.#maxTracks) break;
      const tracks = await this.#tracksOf(discordId, playlist);

      for (const track of tracks) {
        if (collected.length >= this.#maxTracks) break;
        const artist = track.artist.trim();
        const title = track.title.trim();
        if (artist === '' || title === '') continue;

        // Fold here as well as in the pool: the same song sitting on three of
        // their playlists is one statement of taste, not three.
        const key = identityOf(artist, title).key;
        if (seen.has(key)) continue;
        seen.add(key);

        collected.push({
          title,
          author: artist,
          durationMs: track.durationMs,
          uri: track.uri,
          // Matches the dashboard importer's convention, so the same song has
          // one identifier however it reached us.
          identifier: track.spotifyId === null ? '' : `spotify:track:${track.spotifyId}`,
          source: DbMusicSource.SPOTIFY,
          artworkUrl: track.artworkUrl,
          ownerId: discordId,
        });
      }
    }

    logger.debug(
      { discordId, playlists: chosen.length, tracks: collected.length },
      'Spotify taste refreshed',
    );
    return collected;
  }

  /** One playlist's tracks, or none — a single unreadable list is not fatal. */
  async #tracksOf(discordId: string, playlist: UserPlaylist): Promise<readonly UserTrack[]> {
    try {
      return await this.#spotify.playlistTracks(discordId, playlist.spotifyId, TRACKS_PER_PLAYLIST);
    } catch (error) {
      logger.debug(
        { err: error, discordId, playlist: playlist.spotifyId },
        'Skipping unreadable Spotify playlist',
      );
      return [];
    }
  }
}

function cacheKey(discordId: string): string {
  return `spotify-taste:${discordId}`;
}
