import { ForbiddenError, NotFoundError, RateLimitError, UpstreamError } from '../errors/index.js';

/** Never forward Spotify response bodies: they can contain authentication details. */
export function spotifyRequestError(status: number, retryAfter: string | null = null): Error {
  if (status === 401)
    return new UpstreamError(
      'Spotify authorization expired. Reconnect Spotify in dashboard settings, then retry.',
    );
  if (status === 403)
    return new ForbiddenError(
      'Spotify denied access to this playlist or library. Check account permissions; in Development Mode, use a playlist you own or collaborate on.',
    );
  if (status === 404)
    return new NotFoundError(
      'This Spotify item is unavailable, private, or deleted. Check the link and account access.',
    );
  if (status === 429) {
    const seconds = Number(retryAfter);
    const delay =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 86400) : 30;
    return new RateLimitError(
      delay,
      `Spotify rate limit reached. Retry in ${String(delay)} seconds.`,
    );
  }
  return new UpstreamError('Spotify could not complete this request. Try again shortly.');
}
