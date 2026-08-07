/**
 * Lyrics lookup via LRCLIB (lrclib.net) — a free, keyless lyrics database.
 *
 * Best-effort by design: lyrics are a nicety, so any failure (miss, timeout,
 * service down) resolves to null and the caller shows a friendly "not found".
 */
const LRCLIB_ENDPOINT = 'https://lrclib.net/api/get';
const TIMEOUT_MS = 4_000;
/** Discord embed description limit, minus room for the header line. */
const MAX_LYRICS_LENGTH = 3_800;

/** Strip YouTube-channel noise so LRCLIB sees a real artist name. */
function cleanArtist(author: string): string {
  return author.replace(/\s*-\s*Topic$/iu, '').replace(/VEVO$/iu, '');
}

/** Strip common video-title decorations that break exact matching. */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([](?:official|lyric|lyrics|audio|video|visualizer|hd|4k)[^)\]]*[)\]]/giu, '')
    .trim();
}

export async function fetchLyrics(
  title: string,
  author: string,
): Promise<{ readonly lyrics: string; readonly synced: boolean } | null> {
  const params = new URLSearchParams({
    track_name: cleanTitle(title),
    artist_name: cleanArtist(author),
  });

  try {
    const response = await fetch(`${LRCLIB_ENDPOINT}?${params.toString()}`, {
      headers: { 'User-Agent': 'discord-music-platform/0.1.0 (https://github.com)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      plainLyrics?: string | null;
      syncedLyrics?: string | null;
      instrumental?: boolean;
    };
    if (body.instrumental === true) {
      return { lyrics: '*This track is instrumental.*', synced: false };
    }

    const plain = body.plainLyrics?.trim();
    if (plain === undefined || plain === '') return null;

    const truncated =
      plain.length > MAX_LYRICS_LENGTH ? `${plain.slice(0, MAX_LYRICS_LENGTH)}\n…` : plain;
    return { lyrics: truncated, synced: body.syncedLyrics != null };
  } catch {
    return null;
  }
}
