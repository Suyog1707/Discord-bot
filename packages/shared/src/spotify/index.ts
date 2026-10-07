/**
 * Spotify's catalogue, as much of it as more than one runtime needs.
 *
 * Only the search half lives here — the bot's URL resolution, playlist
 * expansion and per-user OAuth stay with the bot, because nothing else has any
 * use for them.
 */
export * from './search.js';
export * from './response.js';
export * from './errors.js';
