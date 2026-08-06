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
export function trackLink(track: Pick<QueuedTrack, 'title' | 'uri'>): string {
  const title = track.title.replaceAll('[', '(').replaceAll(']', ')');
  return track.uri === null ? title : `[${title}](${track.uri})`;
}
