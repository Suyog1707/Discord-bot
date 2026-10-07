/** Spotify renamed playlist `tracks`/`track` to `items`/`item in 2026.
 * Normalize both shapes without confusing an explicitly unavailable item
 * with its legacy fallback. Episodes and malformed records are not music. */
export function spotifyTrack<T>(entry: { item?: T | null; track?: T | null } | null): T | null {
  return entry === null ? null : (('item' in entry ? entry.item : entry.track) ?? null);
}

export function spotifyPlaylistCount(playlist: {
  items?: { total: number } | null;
  tracks?: { total: number } | null;
}): number {
  return playlist.items?.total ?? playlist.tracks?.total ?? 0;
}

/** Never forward a user's bearer token to a pagination URL on another origin. */
export function spotifyApiUrl(path: string): string {
  const url = new URL(path, 'https://api.spotify.com/v1/');
  if (url.origin !== 'https://api.spotify.com' || url.username || url.password) {
    throw new Error('Invalid Spotify pagination origin');
  }
  return url.href;
}
