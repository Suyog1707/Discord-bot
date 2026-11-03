/**
 * SOUNDCLOUD_ENABLED — the switch that keeps the bot from searching SoundCloud.
 *
 * Why it exists: in production every `scsearch:` lookup failed inside Lavalink
 * with "Did not detect any supported formats", the resolver logged
 * `fromSoundcloud: 0` on every resolution, and each Spotify playlist track
 * still paid for several SoundCloud searches. Off (the default) must mean the
 * bot never sends a `scsearch:` query and never waits on one; on must mean
 * exactly what happened before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};

// The logger reads LOG_LEVEL and isProduction through this module too, so the
// mock has to answer for it — a no-match resolution logs at info.
vi.mock('../config/env.js', () => ({
  getEnv: () => env,
  isProduction: () => false,
  isDevelopment: () => false,
}));

const { canonicalTrack } = await import('./canonical-track.js');
const { resolvePlayback } = await import('./playback-resolver.js');
const { buildSearchQuery } = await import('./track.js');
const { enabledProviderOrder, getResolutionSettings, providerOrderFor, resetResolutionSettings } =
  await import('./resolution-settings.js');
const {
  isSoundcloudUrl,
  explainSoundcloudLinkFailure,
  soundcloudSearchRefusal,
  SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE,
  SOUNDCLOUD_SEARCH_DISABLED_MESSAGE,
} = await import('./soundcloud.js');

import type { MatchCandidate, PlaybackProvider } from './candidate-matcher.js';
import type { ProviderSearch } from './playback-resolver.js';

function configure(overrides: Record<string, unknown>): void {
  for (const key of Object.keys(env)) Reflect.deleteProperty(env, key);
  Object.assign(env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLAYBACK_PROVIDER_ORDER: 'youtube,soundcloud',
    MATCH_DURATION_TOLERANCE_MS: 12_000,
    MATCH_SOUNDCLOUD_MIN_SCORE: 70,
    MATCH_YOUTUBE_MIN_SCORE: 55,
    MATCH_OFFICIAL_CHANNELS: undefined,
    SOUNDCLOUD_ENABLED: false,
    ...overrides,
  });
  resetResolutionSettings();
}

beforeEach(() => {
  configure({});
});

let seq = 0;
function upload(title: string, author: string, durationMs: number): MatchCandidate {
  seq += 1;
  return { title, author, durationMs, isStream: false, identifier: `sc-${String(seq)}` };
}

const wanted = canonicalTrack({
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  durationMs: 200_000,
  isrc: 'USUM71900028',
  provider: 'spotify',
});

/**
 * A stub catalogue that records the Lavalink identifier each search would
 * have sent — built with the same `buildSearchQuery` the music manager uses,
 * so "no scsearch: was issued" is asserted on the real prefix.
 */
function catalogue(shelves: Partial<Record<PlaybackProvider, readonly MatchCandidate[]>>): {
  readonly search: ProviderSearch<MatchCandidate>;
  readonly identifiers: string[];
} {
  const identifiers: string[] = [];
  const search: ProviderSearch<MatchCandidate> = (query, provider) => {
    identifiers.push(buildSearchQuery(query, provider));
    return Promise.resolve(shelves[provider] ?? []);
  };
  return { search, identifiers };
}

/** YouTube has only things that are not the song; SoundCloud has the song. */
const youtubeRejectsEverything = {
  youtube: [
    upload('Blinding Lights - Movie Scene | After Hours', 'Film Clips HD', 200_000),
    upload('After Hours Best Scene', 'MovieClips', 205_000),
  ],
  soundcloud: [upload('Blinding Lights', 'The Weeknd', 200_000)],
};

describe('resolution settings with SoundCloud off (the default)', () => {
  it('drops SoundCloud from the configured provider order', () => {
    const settings = getResolutionSettings();
    expect(settings.soundcloudEnabled).toBe(false);
    expect(settings.order).toEqual(['youtube']);
  });

  it('drops SoundCloud whichever order it was configured in', () => {
    configure({ PLAYBACK_PROVIDER_ORDER: 'soundcloud,youtube' });
    expect(getResolutionSettings().order).toEqual(['youtube']);
  });

  it('falls back to YouTube rather than an empty order when only SoundCloud was configured', () => {
    // An empty order would make every track an honest miss; YouTube is the one
    // provider left, so it is what a SoundCloud-only configuration degrades to.
    configure({ PLAYBACK_PROVIDER_ORDER: 'soundcloud' });
    expect(getResolutionSettings().order).toEqual(['youtube']);
  });

  it('never issues a scsearch: query, even when YouTube rejects every candidate', async () => {
    const { search, identifiers } = catalogue(youtubeRejectsEverything);

    const { result, trace } = await resolvePlayback(wanted, search, {
      order: getResolutionSettings().order,
      weights: getResolutionSettings().weights,
    });

    expect(identifiers.length).toBeGreaterThan(0);
    expect(identifiers.every((id) => id.startsWith('ytsearch:'))).toBe(true);
    expect(identifiers.some((id) => id.startsWith('scsearch:'))).toBe(false);
    // Nothing is waited on either: the only attempt is YouTube's.
    expect(trace.attempts.map((attempt) => attempt.provider)).toEqual(['youtube']);
    expect(result).toBeNull();
  });

  it('pins an explicit SoundCloud preference to nothing, so no search runs at all', () => {
    expect(providerOrderFor('soundcloud', getResolutionSettings())).toEqual([]);
  });

  it('leaves auto and an explicit YouTube preference on YouTube', () => {
    expect(providerOrderFor('auto', getResolutionSettings())).toEqual(['youtube']);
    expect(providerOrderFor('youtube', getResolutionSettings())).toEqual(['youtube']);
  });
});

describe('resolution settings with SOUNDCLOUD_ENABLED=true', () => {
  beforeEach(() => {
    configure({ SOUNDCLOUD_ENABLED: true });
  });

  it('keeps the configured provider order exactly as before', () => {
    const settings = getResolutionSettings();
    expect(settings.soundcloudEnabled).toBe(true);
    expect(settings.order).toEqual(['youtube', 'soundcloud']);

    configure({ SOUNDCLOUD_ENABLED: true, PLAYBACK_PROVIDER_ORDER: 'soundcloud,youtube' });
    expect(getResolutionSettings().order).toEqual(['soundcloud', 'youtube']);

    configure({ SOUNDCLOUD_ENABLED: true, PLAYBACK_PROVIDER_ORDER: 'soundcloud' });
    expect(getResolutionSettings().order).toEqual(['soundcloud']);
  });

  it('falls through to SoundCloud when YouTube rejects every candidate, as before', async () => {
    const { search, identifiers } = catalogue(youtubeRejectsEverything);

    const { result, trace } = await resolvePlayback(wanted, search, {
      order: getResolutionSettings().order,
      weights: getResolutionSettings().weights,
    });

    expect(identifiers.some((id) => id.startsWith('scsearch:'))).toBe(true);
    expect(result?.provider).toBe('soundcloud');
    expect(trace.attempts.map((attempt) => attempt.provider)).toEqual(['youtube', 'soundcloud']);
  });

  it('honours an explicit SoundCloud preference', () => {
    expect(providerOrderFor('soundcloud', getResolutionSettings())).toEqual(['soundcloud']);
    expect(providerOrderFor('auto', getResolutionSettings())).toEqual(['youtube', 'soundcloud']);
  });
});

describe('enabledProviderOrder', () => {
  it('is the identity when SoundCloud is enabled', () => {
    expect(enabledProviderOrder(['soundcloud', 'youtube'], true)).toEqual([
      'soundcloud',
      'youtube',
    ]);
    expect(enabledProviderOrder(['youtube'], true)).toEqual(['youtube']);
  });

  it('removes SoundCloud and never returns an empty order when disabled', () => {
    expect(enabledProviderOrder(['youtube', 'soundcloud'], false)).toEqual(['youtube']);
    expect(enabledProviderOrder(['soundcloud'], false)).toEqual(['youtube']);
  });
});

describe('isSoundcloudUrl', () => {
  it.each([
    'https://soundcloud.com/theweeknd/blinding-lights',
    'http://soundcloud.com/artist/track',
    'https://www.soundcloud.com/artist/track',
    'https://m.soundcloud.com/artist/track',
    'https://on.soundcloud.com/AbCdEf',
    'https://snd.sc/AbCdEf',
    '  https://SoundCloud.com/Artist/Track?si=123  ',
  ])('recognises %s', (input) => {
    expect(isSoundcloudUrl(input)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=4NRXx6U8ABQ',
    'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    'https://notsoundcloud.com/artist/track',
    'https://soundcloud.com.evil.example/artist/track',
    'soundcloud.com/artist/track is great',
    'blinding lights soundcloud',
    'not a url',
  ])('does not treat %s as a SoundCloud link', (input) => {
    expect(isSoundcloudUrl(input)).toBe(false);
  });
});

describe('soundcloudSearchRefusal (/play source:SoundCloud)', () => {
  it('refuses a SoundCloud-pinned text search while SoundCloud is off', () => {
    expect(soundcloudSearchRefusal('blinding lights', 'soundcloud', false)).toBe(
      SOUNDCLOUD_SEARCH_DISABLED_MESSAGE,
    );
  });

  it('allows it when SoundCloud is on, and never refuses auto or YouTube', () => {
    expect(soundcloudSearchRefusal('blinding lights', 'soundcloud', true)).toBeNull();
    expect(soundcloudSearchRefusal('blinding lights', 'auto', false)).toBeNull();
    expect(soundcloudSearchRefusal('blinding lights', 'youtube', false)).toBeNull();
  });

  it('does not refuse a URL: the source option does not apply to links', () => {
    expect(
      soundcloudSearchRefusal('https://soundcloud.com/artist/track', 'soundcloud', false),
    ).toBeNull();
    expect(
      soundcloudSearchRefusal('https://www.youtube.com/watch?v=x', 'soundcloud', false),
    ).toBeNull();
  });

  it('tells the listener what to do instead', () => {
    expect(SOUNDCLOUD_SEARCH_DISABLED_MESSAGE).toMatch(/SoundCloud/u);
    expect(SOUNDCLOUD_SEARCH_DISABLED_MESSAGE).toMatch(/YouTube/u);
  });
});

describe('explainSoundcloudLinkFailure (direct SoundCloud link in /play)', () => {
  it('explains a failed SoundCloud link while SoundCloud is off', () => {
    expect(explainSoundcloudLinkFailure('https://soundcloud.com/artist/track', false)).toBe(
      SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE,
    );
  });

  it('leaves the existing error alone when SoundCloud is on', () => {
    expect(explainSoundcloudLinkFailure('https://soundcloud.com/artist/track', true)).toBeNull();
  });

  it('leaves every other link alone', () => {
    expect(explainSoundcloudLinkFailure('https://www.youtube.com/watch?v=x', false)).toBeNull();
    expect(explainSoundcloudLinkFailure('https://example.com/audio.mp3', false)).toBeNull();
  });

  it('suggests a working alternative', () => {
    expect(SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE).toMatch(/SoundCloud/u);
    expect(SOUNDCLOUD_LINK_UNAVAILABLE_MESSAGE).toMatch(/YouTube|Spotify|search/u);
  });
});
