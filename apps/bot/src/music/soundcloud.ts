/**
 * SoundCloud policy: when the bot may search it, and what to tell the user
 * when it may not.
 *
 * Production evidence: every `scsearch:` lookup failed inside Lavalink with
 * "FriendlyException: Something went wrong while looking up the track. Caused
 * by: java.lang.RuntimeException: Did not detect any supported formats", and the
 * resolver logged `fromSoundcloud: 0` on every resolution. SoundCloud search
 * only added load and latency, so it is off unless `SOUNDCLOUD_ENABLED` opts in.
 *
 * The policy: while off, the bot never sends a `scsearch:` query and never
 * waits on one. Direct SoundCloud *links* are different — Lavalink's own
 * SoundCloud source stays enabled, so a link may still work — but if one fails
 * the user gets an explanation rather than a generic error.
 *
 * Pure functions only; the flag is passed in so these are trivially testable.
 */
import type { PlaybackProvider } from './candidate-matcher.js';

/** Shown when `/play source:SoundCloud` is used with free text while SoundCloud search is off. */
export const SOUNDCLOUD_SEARCH_DISABLED_MESSAGE =
  'SoundCloud search is turned off on this bot. Leave the source on auto or pick YouTube.';

/** Shown when a direct SoundCloud link fails to load while SoundCloud is off. */
export const SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE =
  'That SoundCloud link could not be played — SoundCloud playback is currently unavailable on this bot. Try a YouTube or Spotify link, or search for the song by name.';

/** Whether `input` is an http(s) URL, as `resolve()` itself decides it. */
function isHttpUrl(input: string): boolean {
  return /^https?:\/\//iu.test(input.trim());
}

/**
 * Whether `input` is a link to SoundCloud.
 *
 * The hostname is parsed rather than pattern-matched on the string, because
 * `notsoundcloud.com` and `soundcloud.com.evil.example` both contain the text
 * "soundcloud.com" and neither is SoundCloud. Free text is never a link.
 */
export function isSoundcloudUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'snd.sc';
}

/**
 * The refusal for a SoundCloud-pinned text search while SoundCloud is off, or
 * null when the request may proceed. A URL is never refused: the source option
 * does not apply to links, which go straight to Lavalink.
 */
export function soundcloudSearchRefusal(
  input: string,
  preference: 'auto' | PlaybackProvider,
  soundcloudEnabled: boolean,
): string | null {
  if (preference !== 'soundcloud' || soundcloudEnabled || isHttpUrl(input)) return null;
  return SOUNDCLOUD_SEARCH_DISABLED_MESSAGE;
}

/**
 * The explanation for a failed direct SoundCloud link while SoundCloud is off,
 * or null when the existing generic error should stand.
 */
export function explainSoundcloudLinkFailure(
  input: string,
  soundcloudEnabled: boolean,
): string | null {
  return !soundcloudEnabled && isSoundcloudUrl(input) ? SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE : null;
}
