import 'server-only';

/**
 * Search-as-you-type, answered where Discord's request lands.
 *
 * Every other interaction is acknowledged and handed to a bot. Autocomplete
 * cannot be: there is no deferral for it, so the suggestions have to be in the
 * HTTP response, inside three seconds. Round-tripping to a bot and back does
 * not fit, and would put a second network hop on a path that fires on every
 * keystroke.
 *
 * So it is answered here, from Spotify — which is where `/play`'s suggestions
 * came from anyway; the ranking is the same code, imported rather than copied.
 * What is lost is the Lavalink fallback the bot used when Spotify was
 * unconfigured, and the honest consequence is that without
 * `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` on this deployment the list is
 * empty. Free text still works; every command that autocompletes accepts it.
 */
import {
  searchSpotifySuggestions,
  toAutocompleteChoices,
  type SpotifySearchHit,
} from '@discord-music/shared';

import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

/** Shared across instances, which the bot's in-process cache never was. */
const CACHE_TTL_SECONDS = 60;
const CACHE_PREFIX = 'dmp:cache:autocomplete:';

/** Below this, the query is too vague to search on. */
const MIN_QUERY_LENGTH = 3;

/**
 * Suggestions for one focused option.
 *
 * Never throws and never rejects: a failure here has to look like "no
 * suggestions", because the alternative is Discord showing an error while
 * somebody is still typing.
 */
export async function autocompleteChoices(payload: unknown): Promise<AutocompleteChoice[]> {
  const query = focusedValueOf(payload);
  // A URL is already the answer; suggesting against it is noise.
  if (query === null || query.length < MIN_QUERY_LENGTH || /^https?:\/\//iu.test(query)) return [];

  const env = getEnv();
  if (env.SPOTIFY_CLIENT_ID === undefined || env.SPOTIFY_CLIENT_SECRET === undefined) return [];

  const cached = await readCache(query);
  if (cached !== null) return cached;

  const hits: readonly SpotifySearchHit[] = await searchSpotifySuggestions(
    { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET },
    query,
  );
  const choices = toAutocompleteChoices(hits);

  // Cached even when empty: a query Spotify cannot answer would otherwise be
  // re-asked on every keystroke that follows it.
  await writeCache(query, choices);
  return choices;
}

/** The option the user is currently typing into. */
function focusedValueOf(payload: unknown): string | null {
  const options = (payload as { readonly data?: { readonly options?: readonly unknown[] } } | null)
    ?.data?.options;
  if (options === undefined) return null;

  for (const option of options) {
    const entry = option as {
      readonly focused?: unknown;
      readonly value?: unknown;
      readonly options?: readonly unknown[];
    };
    if (entry.focused === true && typeof entry.value === 'string') return entry.value.trim();
    // Subcommands nest their options one level down.
    if (entry.options !== undefined) {
      const nested = focusedValueOf({ data: { options: entry.options } });
      if (nested !== null) return nested;
    }
  }
  return null;
}

async function readCache(query: string): Promise<AutocompleteChoice[] | null> {
  const redis = getRedis();
  if (redis === undefined) return null;
  try {
    const raw = await redis.get(CACHE_PREFIX + query);
    return raw === null ? null : (JSON.parse(raw) as AutocompleteChoice[]);
  } catch {
    return null;
  }
}

async function writeCache(query: string, choices: AutocompleteChoice[]): Promise<void> {
  const redis = getRedis();
  if (redis === undefined) return;
  try {
    await redis.set(CACHE_PREFIX + query, JSON.stringify(choices), 'EX', CACHE_TTL_SECONDS);
  } catch (error) {
    getLogger('interactions').debug({ err: error }, 'Could not cache suggestions');
  }
}
