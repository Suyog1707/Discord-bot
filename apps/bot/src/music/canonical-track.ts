/**
 * The canonical track: what song the user actually wants.
 *
 * This is the hinge of the resolution architecture. The old flow asked one
 * question — "what does a search for this text return?" — and whatever came
 * back was played. That is how a movie scene ends up in a voice channel: the
 * scene is a perfectly good *search result*, it is just not the song.
 *
 * The new flow splits that into two questions asked in order:
 *
 *   1. What exact recording is being requested?   → this module
 *   2. Which playable upload most accurately IS   → `candidate-matcher`
 *      that recording?                              `playback-resolver`
 *
 * A `CanonicalTrack` is the answer to (1), normalised so that every downstream
 * consumer sees the same shape no matter which metadata provider supplied it.
 * Spotify, Apple Music and Deezer all describe a recording differently; nothing
 * below this module should have to know which one spoke.
 *
 * Nothing here touches audio. Metadata providers identify; playback providers
 * stream. Keeping those apart is what makes "the same song, from whichever
 * source can actually play it" expressible at all.
 */
import { identityOf } from '../ai/identity.js';

/** Which catalogue identified this recording. `query` means "nobody did". */
export type MetadataProvider = 'spotify' | 'apple-music' | 'deezer' | 'query';

/**
 * One recording, described the same way regardless of who described it.
 *
 * Every field beyond `title`/`artist` is optional in practice because the
 * providers disagree about what they expose — Spotify's public embed renders no
 * ISRC and no album, the iTunes search API has no ISRC at all — so the matcher
 * treats each signal as "use it when present", never as a requirement.
 */
export interface CanonicalTrack {
  /** Recording title as the catalogue spells it, decoration included. */
  readonly title: string;
  /** Lead credit. What a playback provider is most likely to name. */
  readonly primaryArtist: string;
  /** Every credited artist, lead first. Collaborations are uploaded under any of them. */
  readonly artists: readonly string[];
  readonly album: string | null;
  /** Canonical running time. 0 means "unknown", never "instant". */
  readonly durationMs: number;
  /**
   * International Standard Recording Code. The only identifier in this object
   * that names a *recording* rather than describing one, which is why the
   * matcher treats it as decisive when both sides carry it.
   */
  readonly isrc: string | null;
  /** Release date as the provider gave it (ISO-ish, possibly year-only). */
  readonly releaseDate: string | null;
  readonly provider: MetadataProvider;
  /** Provider-scoped id, when the provider exposes one. */
  readonly providerId: string | null;
  /** The catalogue page for this recording — what listeners are shown. */
  readonly url: string | null;
  /** Artwork from the catalogue, preferred over whatever the audio source has. */
  readonly artworkUrl: string | null;
}

/** ISRCs are compared case-insensitively and without the cosmetic dashes. */
export function normaliseIsrc(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replace(/[^A-Za-z0-9]/gu, '').toUpperCase();
  // A well-formed ISRC is CC-XXX-YY-NNNNN: 12 alphanumerics. Anything else is
  // a provider putting something other than an ISRC in the ISRC field, and a
  // wrong "strongest identifier" is worse than no identifier.
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(cleaned) ? cleaned : null;
}

/** Split a joined credit string ("A, B & C feat. D") into individual names. */
export function splitArtists(artist: string): readonly string[] {
  return (
    artist
      // The trailing `\.?` sits outside the word boundary on purpose: "feat."
      // has no boundary between the dot and the following space, so a `\b`
      // after the optional dot never matches and the dot survives into the next
      // name ("Dua Lipa feat. DaBaby" → ". DaBaby").
      .split(/,|&|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\b\.?/iu)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  );
}

interface CanonicalInput {
  readonly title: string;
  readonly artist: string;
  readonly artists?: readonly string[];
  readonly album?: string | null;
  readonly durationMs?: number;
  readonly isrc?: string | null;
  readonly releaseDate?: string | null;
  readonly provider: MetadataProvider;
  readonly providerId?: string | null;
  readonly url?: string | null;
  readonly artworkUrl?: string | null;
}

/**
 * Build a canonical track, filling in the derived fields.
 *
 * The artist list is derived from the joined credit when a provider does not
 * hand one over, because "who might this be uploaded under" is a question the
 * matcher asks constantly and re-splitting the string at every call site is how
 * the old code ended up with three slightly different splitters.
 */
export function canonicalTrack(input: CanonicalInput): CanonicalTrack {
  const artists =
    input.artists !== undefined && input.artists.length > 0
      ? input.artists.filter((name) => name.trim().length > 0)
      : splitArtists(input.artist);
  const primaryArtist = artists[0] ?? input.artist.trim();

  return {
    title: input.title.trim(),
    primaryArtist,
    artists: artists.length > 0 ? artists : [primaryArtist].filter((name) => name.length > 0),
    album: input.album?.trim() ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
    isrc: normaliseIsrc(input.isrc),
    releaseDate: input.releaseDate ?? null,
    provider: input.provider,
    providerId: input.providerId ?? null,
    url: input.url ?? null,
    artworkUrl: input.artworkUrl ?? null,
  };
}

/** The joined credit, the way a search query wants it. */
export function joinedArtists(track: CanonicalTrack): string {
  return track.artists.join(', ');
}

/**
 * Stable cache key for one recording.
 *
 * ISRC first and alone when present: it identifies the recording globally, so
 * two catalogues describing the same master collapse to one cache entry rather
 * than each paying for its own resolution.
 *
 * Without an ISRC the key falls back to canonical identity plus a coarse
 * duration bucket. The bucket is what stops "Song (Live)" at 5:10 sharing a key
 * with the 3:48 studio cut when a provider's title decoration happened to
 * normalise away — a cache hit on the wrong recording is exactly the silent
 * wrong-song substitution this whole change exists to prevent.
 */
export function canonicalKey(track: CanonicalTrack): string {
  if (track.isrc !== null) return `isrc:${track.isrc}`;
  const identity = identityOf(joinedArtists(track), track.title);
  const bucket = track.durationMs > 0 ? Math.round(track.durationMs / 5_000) : 'na';
  return `id:${identity.key}|${String(bucket)}`;
}

/** One-line description for logs. */
export function describeCanonical(track: CanonicalTrack): string {
  return `${joinedArtists(track)} — ${track.title}`;
}
