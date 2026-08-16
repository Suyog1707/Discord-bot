/**
 * Track domain model.
 *
 * `QueuedTrack` is the bot's internal representation: everything needed to
 * replay (the opaque `encoded` blob), display (title/author/artwork) and
 * attribute (requestedBy*) a track, decoupled from Shoukaku's wire type.
 */
import type { MusicSource } from '@discord-music/shared';
import type { Track as LavalinkTrack } from 'shoukaku';

export interface QueuedTrack {
  readonly encoded: string;
  readonly identifier: string;
  readonly title: string;
  readonly author: string;
  readonly durationMs: number;
  readonly uri: string | null;
  readonly artworkUrl: string | null;
  readonly isStream: boolean;
  readonly source: MusicSource;
  /** Discord user id of the requester. */
  readonly requestedById: string;
  /** Display name captured at request time (avoids a lookup at render time). */
  readonly requestedByName: string;
}

/** Lavalink `sourceName` → our source enum, defaulting unknowns to YouTube. */
export function mapSource(sourceName: string): MusicSource {
  switch (sourceName.toLowerCase()) {
    case 'spotify':
      return 'spotify';
    case 'soundcloud':
      return 'soundcloud';
    case 'deezer':
      return 'deezer';
    default:
      return 'youtube';
  }
}

export function fromLavalinkTrack(
  track: LavalinkTrack,
  requestedBy: { readonly id: string; readonly name: string },
): QueuedTrack {
  return {
    encoded: track.encoded,
    identifier: track.info.identifier,
    title: track.info.title,
    author: track.info.author,
    durationMs: track.info.length,
    uri: track.info.uri ?? null,
    artworkUrl: track.info.artworkUrl ?? null,
    isStream: track.info.isStream,
    source: mapSource(track.info.sourceName),
    requestedById: requestedBy.id,
    requestedByName: requestedBy.name,
  };
}

const URL_PATTERN = /^https?:\/\//iu;

/**
 * Turn user input into a Lavalink identifier: URLs pass through untouched,
 * free text becomes a search on the chosen source.
 */
export function buildSearchQuery(input: string, source: 'youtube' | 'soundcloud'): string {
  const trimmed = input.trim();
  if (URL_PATTERN.test(trimmed)) return trimmed;
  return source === 'soundcloud' ? `scsearch:${trimmed}` : `ytsearch:${trimmed}`;
}

/** `m:ss` / `h:mm:ss`, or a live indicator for streams. */
export function formatTrackDuration(track: Pick<QueuedTrack, 'durationMs' | 'isStream'>): string {
  if (track.isStream) return '🔴 LIVE';

  const totalSeconds = Math.floor(track.durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = seconds.toString().padStart(2, '0');

  return hours > 0
    ? `${String(hours)}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`
    : `${String(minutes)}:${paddedSeconds}`;
}

/** Markdown link to the track, safe when the URI is missing. */
/**
 * Words that mark a different recording of the same song. A fallback source is
 * only useful if it plays what was asked for — a remix or a live cut is a
 * different track, and silently substituting one is worse than skipping.
 */
const VARIANT_MARKERS = [
  'remix',
  'cover',
  'live',
  'karaoke',
  'instrumental',
  'sped up',
  'slowed',
  'reverb',
  'mashup',
  'edit',
  'lofi',
  'lo-fi',
];

/** Lowercase, punctuation to spaces, whitespace collapsed. Brackets kept. */
function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * `flatten`, minus bracketed asides — "(Official Video)" and friends are noise
 * when comparing which song this is. Variant detection deliberately does *not*
 * use this: "(Revoic Remix)" is the whole point and must survive.
 */
function normaliseTitle(value: string): string {
  return flatten(value.replace(/[([{][^)\]}]*[)\]}]/gu, ' '));
}

function significantWords(value: string): string[] {
  return normaliseTitle(value)
    .split(' ')
    .filter((word) => word.length > 2);
}

/**
 * Whether `candidate` is the same recording as `original`, well enough to play
 * in its place.
 *
 * Search on a fallback source happily returns *something* for any query — a
 * remix, or another track by the same artist — so a match is only accepted when
 * the words line up, the running time is close, and the candidate is not
 * flagged as a variant the original never claimed to be.
 */
export function isPlausibleAlternative(
  original: Pick<QueuedTrack, 'title' | 'author' | 'durationMs'>,
  candidate: Pick<QueuedTrack, 'title' | 'author' | 'durationMs'>,
): boolean {
  const wanted = significantWords(original.title);
  if (wanted.length === 0) return false;

  // Match against title + artist: sources disagree about which half of
  // "Artist - Song" belongs in the title field.
  const haystack = normaliseTitle(`${candidate.title} ${candidate.author}`);
  const overlap = wanted.filter((word) => haystack.includes(word)).length / wanted.length;
  if (overlap < 0.7) return false;

  // Raw text on both sides: a remix is usually announced inside brackets, which
  // `normaliseTitle` throws away.
  const candidateText = flatten(`${candidate.title} ${candidate.author}`);
  const originalText = flatten(`${original.title} ${original.author}`);
  const introducedVariant = VARIANT_MARKERS.some(
    (marker) => candidateText.includes(marker) && !originalText.includes(marker),
  );
  if (introducedVariant) return false;

  // A live stream has no meaningful duration to compare against.
  if (original.durationMs <= 0 || candidate.durationMs <= 0) return true;
  const tolerance = Math.max(15_000, original.durationMs * 0.12);
  return Math.abs(original.durationMs - candidate.durationMs) <= tolerance;
}

export function trackLink(track: Pick<QueuedTrack, 'title' | 'uri'>): string {
  const title = track.title.replaceAll('[', '(').replaceAll(']', ')');
  return track.uri === null ? title : `[${title}](${track.uri})`;
}
