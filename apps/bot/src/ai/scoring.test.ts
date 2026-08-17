import { describe, expect, it } from 'vitest';

import {
  type Candidate,
  type ScoredCandidate,
  type ScoringContext,
  dominantLanguage,
  languageOf,
  scoreCandidate,
  selectDiverse,
  selectSequence,
  trackKeyOf,
} from './scoring.js';
import { EMPTY_RECENT_CONTEXT, EMPTY_TASTE_PROFILE, type TasteProfile } from './taste.js';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    title: 'Some Song',
    artist: 'Some Artist',
    origin: 'similar-track',
    match: 0.8,
    ...overrides,
  };
}

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    profile: EMPTY_TASTE_PROFILE,
    recent: EMPTY_RECENT_CONTEXT,
    ...overrides,
  };
}

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return { ...EMPTY_TASTE_PROFILE, confidence: 1, sampleSize: 50, ...overrides };
}

describe('scoreCandidate — similarity', () => {
  it('trusts a track-level match more than a tag chart', () => {
    const base = { title: 'X', artist: 'A', match: 0.9 } as const;
    const similar = scoreCandidate(candidate({ ...base, origin: 'similar-track' }), context());
    const chart = scoreCandidate(candidate({ ...base, origin: 'tag-chart' }), context());

    expect(similar.breakdown.similarity).toBeGreaterThan(chart.breakdown.similarity);
  });

  it('scales with the reported match', () => {
    const strong = scoreCandidate(candidate({ match: 0.9 }), context());
    const weak = scoreCandidate(candidate({ match: 0.1 }), context());

    expect(strong.breakdown.similarity).toBeGreaterThan(weak.breakdown.similarity);
  });
});

describe('scoreCandidate — personal affinity', () => {
  it('rewards an artist the listener completes', () => {
    const liked = scoreCandidate(
      candidate({ artist: 'Karan Aujla' }),
      context({ profile: profile({ artistAffinity: { 'karan aujla': 0.9 } }) }),
    );
    const unknown = scoreCandidate(candidate({ artist: 'Nobody Known' }), context());

    expect(liked.breakdown.userAffinity).toBeGreaterThan(unknown.breakdown.userAffinity);
  });

  it('punishes an artist the listener keeps skipping', () => {
    const disliked = scoreCandidate(
      candidate({ artist: 'Skipped Act' }),
      context({ profile: profile({ artistAffinity: { 'skipped act': -0.9 } }) }),
    );

    expect(disliked.breakdown.userAffinity).toBeLessThan(0.5);
  });

  // Without this a guild's third-ever song establishes a permanent favourite.
  it('ignores affinity from a thin profile', () => {
    const thin = scoreCandidate(
      candidate({ artist: 'Lucky First' }),
      context({
        profile: { ...EMPTY_TASTE_PROFILE, artistAffinity: { 'lucky first': 1 }, confidence: 0 },
      }),
    );

    expect(thin.breakdown.userAffinity).toBeCloseTo(0.5, 5);
  });

  it('matches affinity through a casing variant of the same artist', () => {
    const scored = scoreCandidate(
      candidate({ artist: 'THE WEEKND' }),
      context({ profile: profile({ artistAffinity: { weeknd: 0.9 } }) }),
    );

    expect(scored.breakdown.userAffinity).toBeGreaterThan(0.7);
  });
});

describe('scoreCandidate — language', () => {
  // The headline requirement: a Hindi session must not wander into English pop.
  it('prefers a candidate in the established language', () => {
    const listener = context({
      profile: profile({ languageAffinity: { hindi: 0.9, english: 0.1 } }),
    });

    const hindi = scoreCandidate(candidate({ tags: ['bollywood', 'hindi'] }), listener);
    const english = scoreCandidate(candidate({ tags: ['pop', 'english'] }), listener);

    expect(hindi.breakdown.moodFit).toBeGreaterThan(english.breakdown.moodFit);
    expect(hindi.breakdown.final).toBeGreaterThan(english.breakdown.final);
  });

  it('does not punish a candidate whose language is simply unknown', () => {
    const listener = context({ profile: profile({ languageAffinity: { hindi: 0.9 } }) });

    const untagged = scoreCandidate(candidate({ tags: ['indie', 'chill'] }), listener);
    const wrongLanguage = scoreCandidate(candidate({ tags: ['english', 'pop'] }), listener);

    expect(untagged.breakdown.moodFit).toBeGreaterThan(wrongLanguage.breakdown.moodFit);
  });

  it('does not force a language on a genuinely mixed listener', () => {
    // A 50/50 room has no established language, so similarity should decide.
    const mixed = profile({ languageAffinity: { hindi: 0.5, english: 0.5 } });
    expect(dominantLanguage(mixed)).toBe('hindi'); // exactly at the threshold

    const undecided = profile({ languageAffinity: { hindi: 0.4, english: 0.35, punjabi: 0.25 } });
    expect(dominantLanguage(undecided)).toBeNull();
  });

  it('reads a language out of tags', () => {
    expect(languageOf(['bollywood', 'dance'])).toBe('hindi');
    expect(languageOf(['bhangra'])).toBe('punjabi');
    expect(languageOf(['k-pop'])).toBe('korean');
    expect(languageOf(['indie', 'rock'])).toBeNull();
  });
});

describe('scoreCandidate — mood and genre', () => {
  it('rewards tags the request asked for', () => {
    const asked = context({ desiredTags: ['chill', 'lofi'] });

    const fits = scoreCandidate(candidate({ tags: ['chill', 'lofi'] }), asked);
    const misses = scoreCandidate(candidate({ tags: ['death metal'] }), asked);

    expect(fits.breakdown.moodFit).toBeGreaterThan(misses.breakdown.moodFit);
  });
});

describe('scoreCandidate — penalties', () => {
  it('penalises a track that just played', () => {
    const recent = { ...EMPTY_RECENT_CONTEXT, identifiers: ['abc123'] };

    const repeat = scoreCandidate(candidate({ identifier: 'abc123' }), context({ recent }));
    const fresh = scoreCandidate(candidate({ identifier: 'xyz789' }), context({ recent }));

    expect(repeat.breakdown.recencyPenalty).toBeGreaterThan(0);
    expect(fresh.breakdown.recencyPenalty).toBe(0);
    expect(repeat.breakdown.final).toBeLessThan(fresh.breakdown.final);
  });

  it('penalises the just-played track harder than an older one', () => {
    const recent = {
      ...EMPTY_RECENT_CONTEXT,
      identifiers: ['justnow', ...Array(40).fill('x'), 'longago'],
    };

    const justNow = scoreCandidate(candidate({ identifier: 'justnow' }), context({ recent }));
    const longAgo = scoreCandidate(candidate({ identifier: 'longago' }), context({ recent }));

    expect(justNow.breakdown.recencyPenalty).toBeGreaterThan(longAgo.breakdown.recencyPenalty);
  });

  it('penalises the artist that just played', () => {
    const recent = { ...EMPTY_RECENT_CONTEXT, artists: ['karan aujla'] };
    const sameArtist = scoreCandidate(candidate({ artist: 'Karan Aujla' }), context({ recent }));

    expect(sameArtist.breakdown.artistPenalty).toBeGreaterThan(0);
  });

  it('penalises a track the listener skipped early', () => {
    const recent = { ...EMPTY_RECENT_CONTEXT, skipped: ['rejected'] };

    const skipped = scoreCandidate(candidate({ identifier: 'rejected' }), context({ recent }));
    const notSkipped = scoreCandidate(candidate({ identifier: 'other' }), context({ recent }));

    expect(skipped.breakdown.skipPenalty).toBe(0.5);
    expect(notSkipped.breakdown.skipPenalty).toBe(0);
  });

  // THE repeated-song bug: every anti-repeat signal used to key on the
  // Lavalink identifier, which Last.fm candidates never carry — so a song the
  // guild heard minutes ago scored as fully novel. These pin the fix: matching
  // must work on canonical track keys alone.
  it('penalises a recently played track that has no identifier', () => {
    const recent = {
      ...EMPTY_RECENT_CONTEXT,
      // History rows carry YouTube vocabulary; the candidate carries Last.fm's.
      trackKeys: [trackKeyOf('The Weeknd - Topic', 'Blinding Lights (Official Video)')],
    };
    const repeat = scoreCandidate(
      candidate({ artist: 'The Weeknd', title: 'Blinding Lights' }),
      context({ recent }),
    );

    expect(repeat.breakdown.recencyPenalty).toBeGreaterThan(0.5);
    expect(repeat.breakdown.novelty).toBe(0);
  });

  it('penalises an early-skipped track that has no identifier', () => {
    const recent = {
      ...EMPTY_RECENT_CONTEXT,
      skippedKeys: [trackKeyOf('Artist', 'Rejected Song')],
    };
    const skipped = scoreCandidate(
      candidate({ artist: 'Artist', title: 'Rejected Song [Lyrics]' }),
      context({ recent }),
    );

    expect(skipped.breakdown.skipPenalty).toBe(0.5);
  });

  // Repeated rejection of an ARTIST escalates without banning anyone forever:
  // one skip is mood, a pattern is taste.
  it('escalates the penalty as skips of one artist accumulate', () => {
    const skipsOf = (count: number) => ({
      ...EMPTY_RECENT_CONTEXT,
      skippedArtists: Array<string>(count).fill('rejected act'),
    });
    const at = (count: number) =>
      scoreCandidate(candidate({ artist: 'Rejected Act', title: 'Another Song' }), {
        ...context({ recent: skipsOf(count) }),
      }).breakdown.skipPenalty;

    expect(at(1)).toBe(0);
    expect(at(2)).toBeGreaterThan(0);
    expect(at(3)).toBeGreaterThan(at(2));
  });

  // Anti-drift: "the session sounds like this" must be measured against what
  // the USER put on. When anchor artists are known, adjacency to an artist
  // only autoplay played earns no recent-behaviour reward.
  it('reads session adjacency from user-originated artists only', () => {
    const recent = {
      ...EMPTY_RECENT_CONTEXT,
      artists: ['autoplay act', 'user act'],
      anchorArtists: ['user act'],
    };

    const userAdjacent = scoreCandidate(candidate({ artist: 'User Act' }), context({ recent }));
    const autoplayAdjacent = scoreCandidate(
      candidate({ artist: 'Autoplay Act' }),
      context({ recent }),
    );

    expect(userAdjacent.breakdown.recentBehaviour).toBeGreaterThan(
      autoplayAdjacent.breakdown.recentBehaviour,
    );
  });

  it('applies session artist fatigue over the history-position fallback', () => {
    const tired = scoreCandidate(
      candidate({ artist: 'Tired Act' }),
      context({ artistFatigue: new Map([['tired act', 1]]) }),
    );
    const fresh = scoreCandidate(
      candidate({ artist: 'Fresh Act' }),
      context({ artistFatigue: new Map([['tired act', 1]]) }),
    );

    expect(tired.breakdown.artistPenalty).toBeCloseTo(0.3);
    expect(fresh.breakdown.artistPenalty).toBe(0);
  });

  it('never produces a score outside [0, 1]', () => {
    const punishing = context({
      recent: {
        ...EMPTY_RECENT_CONTEXT,
        identifiers: ['x'],
        artists: ['some artist'],
        skipped: ['x'],
      },
      profile: profile({ artistAffinity: { 'some artist': -1 } }),
    });
    const scored = scoreCandidate(candidate({ identifier: 'x', match: 0 }), punishing);

    expect(scored.breakdown.final).toBeGreaterThanOrEqual(0);
    expect(scored.breakdown.final).toBeLessThanOrEqual(1);
  });
});

describe('selectSequence', () => {
  function scoredPool(
    entries: readonly { artist: string; title: string; match?: number; tags?: string[] }[],
  ): ScoredCandidate[] {
    return entries.map((entry) =>
      scoreCandidate(
        candidate({
          artist: entry.artist,
          title: entry.title,
          match: entry.match ?? 0.8,
          ...(entry.tags === undefined ? {} : { tags: entry.tags }),
        }),
        context(),
      ),
    );
  }

  // The smart-shuffle property: the best QUEUE is not the top-N best SONGS.
  it('avoids back-to-back picks from one artist when alternatives exist', () => {
    const pool = scoredPool([
      { artist: 'Weeknd', title: 'One', match: 0.95 },
      { artist: 'Weeknd', title: 'Two', match: 0.94 },
      { artist: 'Drake', title: 'Three', match: 0.7 },
      { artist: 'Dua Lipa', title: 'Four', match: 0.7 },
      { artist: 'Weeknd', title: 'Five', match: 0.93 },
    ]);

    const picked = selectSequence(pool, 4, {});
    for (let index = 1; index < picked.length; index += 1) {
      expect(picked[index]?.artistKey).not.toBe(picked[index - 1]?.artistKey);
    }
  });

  it('lets a favourite return once fatigue has decayed, without a fixed rule', () => {
    // Ten artists, favourite scores highest. It should appear more than once
    // across a long sequence — diversity must not erase taste — but never
    // consecutively.
    const pool = scoredPool([
      ...Array.from({ length: 4 }, (_, i) => ({
        artist: 'Favourite',
        title: `Fav ${String(i)}`,
        match: 0.95,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        artist: `Other ${String(i % 10)}`,
        title: `Song ${String(i)}`,
        match: 0.75,
      })),
    ]);

    const picked = selectSequence(pool, 12, {});
    const favouriteCount = picked.filter((p) => p.artistKey === 'favourite').length;
    expect(favouriteCount).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < picked.length; index += 1) {
      const both =
        picked[index]?.artistKey === 'favourite' && picked[index - 1]?.artistKey === 'favourite';
      expect(both).toBe(false);
    }
  });

  it('suppresses an artist carrying session fatigue at the first slot', () => {
    const pool = scoredPool([
      { artist: 'Just Played', title: 'A', match: 0.9 },
      { artist: 'Alternative', title: 'B', match: 0.8 },
    ]);

    const picked = selectSequence(pool, 1, {
      artistFatigue: new Map([['just played', 1]]),
    });
    expect(picked[0]?.artistKey).toBe('alternative');
  });

  it('spends discovery slots on artists the listener has never played', () => {
    const known = new Set(['known a', 'known b']);
    const pool = scoredPool([
      { artist: 'Known A', title: 'One', match: 0.9 },
      { artist: 'Known B', title: 'Two', match: 0.9 },
      { artist: 'Known A', title: 'Three', match: 0.88 },
      { artist: 'Known B', title: 'Four', match: 0.88 },
      { artist: 'New Face', title: 'Five', match: 0.7 },
      { artist: 'Other New', title: 'Six', match: 0.69 },
    ]);

    const withDiscovery = selectSequence(pool, 6, { discoveryLevel: 0.34, knownArtists: known });
    const discovered = withDiscovery.filter((p) => !known.has(p.artistKey)).length;
    expect(discovered).toBeGreaterThanOrEqual(1);

    const without = selectSequence(pool, 4, { discoveryLevel: 0, knownArtists: known });
    expect(without.every((p) => known.has(p.artistKey) || p.breakdown.final > 0)).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const pool = scoredPool(
      Array.from({ length: 30 }, (_, i) => ({
        artist: `Artist ${String(i % 7)}`,
        title: `Song ${String(i)}`,
        match: 0.9 - i * 0.01,
      })),
    );
    const a = selectSequence(pool, 10, {}).map((p) => p.trackKey);
    const b = selectSequence(pool, 10, {}).map((p) => p.trackKey);
    expect(a).toEqual(b);
  });

  it('never picks the same canonical track twice', () => {
    const pool = scoredPool([
      { artist: 'A', title: 'Song (Official Video)' },
      { artist: 'A', title: 'Song' },
      { artist: 'B', title: 'Other' },
    ]);
    const picked = selectSequence(pool, 3, {});
    const keys = picked.map((p) => p.trackKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === trackKeyOf('A', 'Song')).length).toBeLessThanOrEqual(1);
  });
});

describe('selectDiverse', () => {
  /** N tracks by one artist, all scoring identically well. */
  function byArtist(artist: string, count: number): Candidate[] {
    return Array.from({ length: count }, (_, index) => ({
      title: `${artist} Song ${String(index)}`,
      artist,
      origin: 'similar-track' as const,
      match: 0.9,
    }));
  }

  const ctx = context();

  /** Count picks per artist. */
  function tally(picked: readonly { readonly artistKey: string }[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of picked) counts.set(entry.artistKey, (counts.get(entry.artistKey) ?? 0) + 1);
    return counts;
  }

  it('caps one artist to a few tracks in a short queue', () => {
    // A realistic pool: several artists, all scoring equally well. The cap alone
    // decides the spread, with no overflow needed to fill ten slots.
    const scored = ['A', 'B', 'C', 'D', 'E']
      .flatMap((artist) => byArtist(artist, 20))
      .map((c) => scoreCandidate(c, ctx));
    const picked = selectDiverse(scored, 10);

    expect(picked).toHaveLength(10);
    for (const count of tally(picked).values()) expect(count).toBeLessThanOrEqual(3);
  });

  // The bug this caught: overflow was unbounded, so a pool containing one artist
  // handed that artist the entire queue — the exact failure the cap exists for.
  it('never lets one artist own the majority, even when the pool is thin', () => {
    const scored = byArtist('Dominant Act', 40).map((c) => scoreCandidate(c, ctx));
    const picked = selectDiverse(scored, 10);

    expect(picked.length).toBeLessThanOrEqual(5);
    expect(picked.length).toBeGreaterThan(2);
  });

  it('allows more from one artist across a long playlist, but still spreads', () => {
    const scored = ['A', 'B', 'C']
      .flatMap((artist) => byArtist(artist, 200))
      .map((c) => scoreCandidate(c, ctx));
    const picked = selectDiverse(scored, 300);

    const counts = tally(picked);
    expect(counts.size).toBe(3);
    // 300 / 25 = 12 each before overflow; overflow then fills toward 300 but is
    // itself capped at half the request, so no artist can dominate.
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(150);
  });

  it('fills the request from overflow rather than returning a short queue', () => {
    // Only two artists exist, so a strict cap could not reach 50 tracks.
    const scored = [...byArtist('A', 40), ...byArtist('B', 40)].map((c) => scoreCandidate(c, ctx));
    const picked = selectDiverse(scored, 50);

    expect(picked).toHaveLength(50);
  });

  it('never repeats the same track', () => {
    const duplicated = [
      candidate({ title: 'Same Song', artist: 'A' }),
      candidate({ title: 'same song', artist: 'A' }),
      candidate({ title: 'Same Song (Official Video)', artist: 'A' }),
    ].map((c) => scoreCandidate(c, ctx));

    expect(selectDiverse(duplicated, 10)).toHaveLength(1);
  });

  it('honours a request to stay with one artist', () => {
    const scored = byArtist('Only This One', 20).map((c) => scoreCandidate(c, ctx));
    const picked = selectDiverse(scored, 10, { enforceArtistDiversity: false });

    expect(picked).toHaveLength(10);
  });

  it('returns candidates in descending score order', () => {
    const scored = [
      scoreCandidate(candidate({ artist: 'A', match: 0.2 }), ctx),
      scoreCandidate(candidate({ artist: 'B', match: 0.9 }), ctx),
      scoreCandidate(candidate({ artist: 'C', match: 0.5 }), ctx),
    ];
    const picked = selectDiverse(scored, 3);

    expect(picked.map((entry) => entry.artistKey)).toEqual(['b', 'c', 'a']);
  });
});
