import { describe, expect, it, vi } from 'vitest';

import { canonicalTrack, type CanonicalTrack } from './canonical-track.js';
import {
  requestedVariantsOf,
  type MatchCandidate,
  type PlaybackProvider,
} from './candidate-matcher.js';
import {
  formatResolutionTrace,
  resolvePlayback,
  ResolutionCache,
  type ProviderSearch,
} from './playback-resolver.js';
import { buildSearchQuery } from './track.js';

let seq = 0;
function upload(
  title: string,
  author: string,
  durationMs: number,
  extra: Partial<MatchCandidate> = {},
): MatchCandidate {
  seq += 1;
  return { title, author, durationMs, isStream: false, identifier: `id-${String(seq)}`, ...extra };
}

const wanted: CanonicalTrack = canonicalTrack({
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  durationMs: 200_000,
  isrc: 'USUM71900028',
  provider: 'spotify',
});

/**
 * A stub catalogue. Every query against a provider returns that provider's
 * whole shelf, which keeps these tests about the resolution policy rather than
 * about how a particular search engine ranks strings.
 */
function catalogue(shelves: Partial<Record<PlaybackProvider, readonly MatchCandidate[]>>): {
  readonly search: ProviderSearch<MatchCandidate>;
  readonly calls: PlaybackProvider[];
} {
  const calls: PlaybackProvider[] = [];
  const search: ProviderSearch<MatchCandidate> = (_query, provider) => {
    calls.push(provider);
    return Promise.resolve(shelves[provider] ?? []);
  };
  return { search, calls };
}

describe('provider priority', () => {
  it('plays a confident SoundCloud match without ever asking YouTube', async () => {
    const { search, calls } = catalogue({
      soundcloud: [upload('Blinding Lights', 'The Weeknd', 200_000)],
      youtube: [upload('Blinding Lights', 'The Weeknd - Topic', 200_000)],
    });

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('soundcloud');
    expect(result?.candidate.author).toBe('The Weeknd');
    expect(calls).not.toContain('youtube');
    expect(trace.decision).toBe('play');
  });

  it('falls through to YouTube when SoundCloud has nothing acceptable', async () => {
    const { search, calls } = catalogue({
      // Present on SoundCloud, but as somebody's sped-up bootleg.
      soundcloud: [upload('Blinding Lights (Sped Up)', 'nightcorezone', 150_000)],
      youtube: [upload('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000)],
    });

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('youtube');
    expect(calls).toContain('soundcloud');
    expect(trace.attempts[0]?.provider).toBe('soundcloud');
    expect(trace.attempts[0]?.decision).not.toBe('play');
  });

  it('falls through when SoundCloud returns nothing at all', async () => {
    const { search } = catalogue({
      soundcloud: [],
      youtube: [upload('Blinding Lights', 'The Weeknd - Topic', 200_000)],
    });

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('youtube');
    expect(trace.attempts[0]?.decision).toBe('no-candidates');
  });

  it('honours an explicit single-provider order without falling through', async () => {
    const { search, calls } = catalogue({
      soundcloud: [],
      youtube: [upload('Blinding Lights', 'The Weeknd - Topic', 200_000)],
    });

    const { result } = await resolvePlayback(wanted, search, { order: ['soundcloud'] });

    expect(result).toBeNull();
    expect(calls).not.toContain('youtube');
  });
});

describe('rejecting what is not the song', () => {
  it('refuses a movie scene that is the only YouTube result', async () => {
    const { search } = catalogue({
      soundcloud: [],
      youtube: [
        upload('Blinding Lights - Movie Scene | After Hours', 'Film Clips HD', 200_000),
        upload('After Hours Best Scene', 'MovieClips', 205_000),
      ],
    });

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result).toBeNull();
    expect(trace.decision).toBe('no-match');
    const youtubeAttempt = trace.attempts.find((attempt) => attempt.provider === 'youtube');
    expect(youtubeAttempt?.rejected.length).toBeGreaterThan(0);
    expect(youtubeAttempt?.rejected[0]?.reason).toContain('non-music');
  });

  it('refuses a scene whose title matches but whose runtime does not', async () => {
    const { search } = catalogue({
      soundcloud: [],
      // Clean title, no give-away keyword — caught on runtime plus channel plus
      // the absent artist, not on any word in the title.
      youtube: [upload('Blinding Lights', 'Bollywood Movies Zone', 262_000)],
    });

    const { result } = await resolvePlayback(wanted, search);
    expect(result).toBeNull();
  });

  it('picks the official audio when it sits beside a movie scene', async () => {
    const { search } = catalogue({
      soundcloud: [],
      youtube: [
        upload('Blinding Lights Scene | After Hours', 'Movie Clips', 200_000),
        upload('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000),
      ],
    });

    const { result } = await resolvePlayback(wanted, search);
    expect(result?.candidate.title).toBe('Blinding Lights (Official Audio)');
  });

  it('plays nothing rather than the best of a bad set', async () => {
    const { search } = catalogue({
      soundcloud: [upload('Blinding Lights (DJ Mashup)', 'partyedits', 320_000)],
      youtube: [
        upload('Blinding Lights REACTION', 'Reactor', 480_000),
        upload('The Weeknd Interview 2020', 'TalkShow', 900_000),
      ],
    });

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result).toBeNull();
    expect(trace.decision).toBe('no-match');
    expect(trace.attempts).toHaveLength(2);
  });
});

describe('version preservation', () => {
  it('prefers the original when no variant was requested', async () => {
    const { search } = catalogue({
      soundcloud: [
        upload('Blinding Lights (Chill Remix)', 'The Weeknd', 201_000),
        upload('Blinding Lights', 'The Weeknd', 200_000),
      ],
    });

    const { result } = await resolvePlayback(wanted, search);
    expect(result?.candidate.title).toBe('Blinding Lights');
  });

  it('plays the remix when the user asked for one', async () => {
    const { search } = catalogue({
      soundcloud: [
        upload('Blinding Lights', 'The Weeknd', 200_000),
        upload('Blinding Lights (Chill Remix)', 'The Weeknd', 201_000),
      ],
    });

    const { result } = await resolvePlayback(wanted, search, {
      requestedVariants: requestedVariantsOf('blinding lights remix'),
    });
    expect(result?.candidate.title).toBe('Blinding Lights (Chill Remix)');
  });

  it('prefers the studio recording when a live take is not what was asked for', async () => {
    const { search } = catalogue({
      soundcloud: [
        upload('Blinding Lights (Live at Wembley)', 'The Weeknd', 208_000),
        upload('Blinding Lights', 'The Weeknd', 200_000),
      ],
    });

    const { result } = await resolvePlayback(wanted, search);
    expect(result?.candidate.title).toBe('Blinding Lights');
  });
});

describe('choosing between close candidates', () => {
  it('takes the highest-confidence candidate, not the first', async () => {
    const { search } = catalogue({
      soundcloud: [
        // First on the shelf and superficially fine — but nothing attributes it
        // and the runtime is off.
        upload('Blinding Lights', 'FreeMusicArchiveX', 213_000),
        upload('Blinding Lights (Official Audio)', 'The Weeknd', 200_000),
        upload('Blinding Lights', 'someuser2011', 199_000),
      ],
    });

    const { result } = await resolvePlayback(wanted, search);
    expect(result?.candidate.author).toBe('The Weeknd');
    expect(result?.authoritative).toBe(true);
  });
});

describe('error handling', () => {
  it('falls through to YouTube when SoundCloud throws', async () => {
    const search: ProviderSearch<MatchCandidate> = (_query, provider) => {
      if (provider === 'soundcloud') return Promise.reject(new Error('soundcloud unreachable'));
      return Promise.resolve([upload('Blinding Lights', 'The Weeknd - Topic', 200_000)]);
    };

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('youtube');
    expect(trace.attempts[0]?.decision).toBe('provider-error');
    expect(trace.attempts[0]?.error).toContain('unreachable');
  });

  it('returns no match when every provider fails', async () => {
    const search: ProviderSearch<MatchCandidate> = () => Promise.reject(new Error('node down'));

    const { result, trace } = await resolvePlayback(wanted, search);

    expect(result).toBeNull();
    expect(trace.attempts.every((attempt) => attempt.decision === 'provider-error')).toBe(true);
  });
});

describe('caching', () => {
  it('reuses an accepted resolution without searching again', async () => {
    const cache = new ResolutionCache<MatchCandidate>();
    const spy = vi.fn<ProviderSearch<MatchCandidate>>((_query, provider) =>
      Promise.resolve(
        provider === 'soundcloud' ? [upload('Blinding Lights', 'The Weeknd', 200_000)] : [],
      ),
    );

    const first = await resolvePlayback(wanted, spy, { cache });
    const callsAfterFirst = spy.mock.calls.length;
    const second = await resolvePlayback(wanted, spy, { cache });

    expect(first.result).not.toBeNull();
    expect(second.result?.candidate.identifier).toBe(first.result?.candidate.identifier);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
    expect(second.trace.cached).toBe(true);
  });

  it('never caches a resolution it refused', async () => {
    const cache = new ResolutionCache<MatchCandidate>();
    const { search } = catalogue({
      soundcloud: [upload('Blinding Lights REACTION', 'Reactor', 480_000)],
      youtube: [],
    });

    const { result } = await resolvePlayback(wanted, search, { cache });

    expect(result).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('shares one entry between catalogues that agree on the ISRC', async () => {
    const cache = new ResolutionCache<MatchCandidate>();
    const { search } = catalogue({
      soundcloud: [upload('Blinding Lights', 'The Weeknd', 200_000)],
    });
    const fromDeezer = canonicalTrack({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      durationMs: 199_000,
      isrc: 'usum7-1900028',
      provider: 'deezer',
    });

    await resolvePlayback(wanted, search, { cache });
    const second = await resolvePlayback(fromDeezer, search, { cache });

    expect(second.trace.cached).toBe(true);
    expect(cache.size).toBe(1);
  });
});

describe('resolution trace', () => {
  it('reads as a diagnosis of what happened', async () => {
    const { search } = catalogue({
      soundcloud: [upload('Blinding Lights (Sped Up)', 'nightcorezone', 150_000)],
      youtube: [upload('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000)],
    });

    const { trace } = await resolvePlayback(wanted, search);
    const text = formatResolutionTrace(trace);

    expect(text).toContain('[MusicResolver]');
    expect(text).toContain('Track: Blinding Lights');
    expect(text).toContain('ISRC: USUM71900028');
    expect(text).toContain('SoundCloud candidates:');
    expect(text).toContain('YouTube candidates:');
    expect(text).toContain('Decision: PLAY from youtube');
  });
});

describe('direct URLs', () => {
  it('passes an HTTP audio URL through untouched, whatever the source preference', () => {
    // The resolver is not involved for a URL: the user named the exact object,
    // and this is what keeps direct HTTP playback working.
    const url = 'https://cdn.example.com/audio/track.mp3';
    expect(buildSearchQuery(url, 'youtube')).toBe(url);
    expect(buildSearchQuery(url, 'soundcloud')).toBe(url);
  });

  it('still turns free text into a provider search', () => {
    expect(buildSearchQuery('blinding lights', 'soundcloud')).toBe('scsearch:blinding lights');
    expect(buildSearchQuery('blinding lights', 'youtube')).toBe('ytsearch:blinding lights');
  });
});

describe('cache and provider pinning', () => {
  it('ignores a cached entry for a provider this call excluded', async () => {
    const cache = new ResolutionCache<MatchCandidate>();
    const { search } = catalogue({
      soundcloud: [upload('Blinding Lights', 'The Weeknd', 200_000)],
      youtube: [upload('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000)],
    });

    const first = await resolvePlayback(wanted, search, { cache });
    expect(first.result?.provider).toBe('soundcloud');

    // Stream recovery pins the walk to the *other* provider. Handing back the
    // cached SoundCloud entry here would return the track that just died.
    const recovery = await resolvePlayback(wanted, search, { cache, order: ['youtube'] });
    expect(recovery.result?.provider).toBe('youtube');
    expect(recovery.trace.cached).toBe(false);
  });
});

describe('searching providers side by side', () => {
  /**
   * SoundCloud still decides first: a confident answer there never touches
   * YouTube, and YouTube's answer is used only once SoundCloud has given up.
   * What changed is *when* YouTube starts — as soon as SoundCloud is unsure,
   * rather than after it has run every query it has.
   */
  const delay = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const bootleg = (): MatchCandidate =>
    upload('Blinding Lights (Sped Up)', 'nightcorezone', 150_000);
  const scOriginal = (): MatchCandidate => upload('Blinding Lights', 'The Weeknd', 200_000);
  const ytOfficial = (): MatchCandidate =>
    upload('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000);

  it('starts YouTube while SoundCloud is still unsure, not after it gives up', async () => {
    const events: string[] = [];
    const search: ProviderSearch<MatchCandidate> = async (_query, provider) => {
      events.push(`${provider}:start`);
      await delay(15);
      events.push(`${provider}:end`);
      return provider === 'soundcloud' ? [bootleg()] : [ytOfficial()];
    };

    const { result } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('youtube');
    expect(events.indexOf('youtube:start')).toBeLessThan(events.lastIndexOf('soundcloud:end'));
  });

  it('still takes SoundCloud when it comes good, even after YouTube has answered', async () => {
    let soundcloudQueries = 0;
    const search: ProviderSearch<MatchCandidate> = async (_query, provider) => {
      if (provider === 'youtube') return [ytOfficial()];
      soundcloudQueries += 1;
      await delay(10);
      return soundcloudQueries === 1 ? [bootleg()] : [scOriginal()];
    };

    const { result } = await resolvePlayback(wanted, search);

    expect(result?.provider).toBe('soundcloud');
  });

  it('stops the other provider once the answer is in', async () => {
    const calls = { soundcloud: 0, youtube: 0 };
    const search: ProviderSearch<MatchCandidate> = async (_query, provider) => {
      calls[provider] += 1;
      if (provider === 'soundcloud') {
        await delay(5);
        return calls.soundcloud === 1 ? [bootleg()] : [scOriginal()];
      }
      await delay(40);
      // Never confident, so without the stop YouTube would run its whole plan.
      return [bootleg()];
    };

    const { result } = await resolvePlayback(wanted, search);
    await delay(150);

    expect(result?.provider).toBe('soundcloud');
    expect(calls.youtube).toBeLessThanOrEqual(1);
  });

  it('starts YouTube alongside a SoundCloud search that is slow to answer', async () => {
    const calls: PlaybackProvider[] = [];
    const search: ProviderSearch<MatchCandidate> = async (_query, provider) => {
      calls.push(provider);
      if (provider === 'soundcloud') {
        await delay(60);
        return [scOriginal()];
      }
      return [ytOfficial()];
    };

    const { result } = await resolvePlayback(wanted, search, { headStartMs: 10 });

    // The head start ran out, so YouTube was asked — and SoundCloud still won.
    expect(calls).toContain('youtube');
    expect(result?.provider).toBe('soundcloud');
  });

  it('runs the searches after the first in pairs', async () => {
    let inFlight = 0;
    let peak = 0;
    const search: ProviderSearch<MatchCandidate> = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;
      return [bootleg()];
    };

    const { trace } = await resolvePlayback(wanted, search, { order: ['youtube'] });

    expect(peak).toBe(2);
    // Every query in the plan still ran: pairing changes the timing, not the plan.
    expect(trace.attempts[0]?.queriesRun).toBeGreaterThan(2);
  });
});
