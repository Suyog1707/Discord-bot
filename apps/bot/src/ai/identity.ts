/**
 * Canonical track identity — one stable key per logical song.
 *
 * The implementation moved to `@discord-music/shared/music-identity` (exported
 * from the isomorphic barrel, since it is pure and browser-safe). It had to:
 * a dislike expressed on the dashboard and a dislike expressed in a voice
 * channel must produce the *same* key, and a second implementation of "the
 * canonical key" is simply a second key — the exact failure the identity layer
 * exists to prevent.
 *
 * This module stays as the bot's import path so every existing caller (autoplay
 * exclusion sets, the recommender, history) is untouched, and so the header
 * above still points a reader at where identity is defined. The full rationale
 * for the noise/variant rules lives with the code in the shared module.
 */
export { identifierKeyOf, identityOf, trackKeyOf, type TrackIdentity } from '@discord-music/shared';
