import { describe, expect, it } from 'vitest';

import {
  type FamiliarCandidate,
  type FamiliarScoringContext,
  type FamiliarSource,
  type ScoredFamiliar,
  explainFamiliar,
  scoreFamiliar,
} from './familiar-scoring.js';
import { EMPTY_RECENT_CONTEXT, EMPTY_TASTE_PROFILE, type TasteProfile } from './taste.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 60 * 60_000;

function candidate(overrides: Partial<FamiliarCandidate> = {}): FamiliarCandidate {
  return {
    title: 'Some Song',
    artist: 'Some Artist',
    durationMs: 210_000,
    uri: 'https://example.test/some-song',
    identifier: 'abc123',
    source: 'spotify',
    artworkUrl: null,
    sources: new Set<FamiliarSource>(['history']),
    plays: 1,
    userPlays: 0,
    completions: 0,
    earlySkips: 0,
    lastPlayedAt: null,
    playlistRelevance: 0.5,
    listenerCount: 1,
    ...overrides,
  };
}

function context(overrides: Partial<FamiliarScoringContext> = {}): FamiliarScoringContext {
  return {
    profile: EMPTY_TASTE_PROFILE,
    recent: EMPTY_RECENT_CONTEXT,
    seedArtists: [],
    now: NOW,
    ...overrides,
  };
}

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return { ...EMPTY_TASTE_PROFILE, confidence: 1, sampleSize: 50, ...overrides };
}

function scoreOf(overrides: Partial<FamiliarCandidate>, ctx = context()): number {
  return scoreFamiliar(candidate(overrides), ctx).score;
}

/**
 * Breakdown values are a loose record, so an index read is `number | undefined`.
 * Tests want the number; a missing signal should fail loudly, not silently pass.
 */
function signal(entry: ScoredFamiliar, name: string): number {
  return entry.breakdown[name] ?? Number.NaN;
}

function sources(...values: readonly FamiliarSource[]): ReadonlySet<FamiliarSource> {
  return new Set(values);
}

describe('scoreFamiliar — provenance', () => {
  // A human putting the song somewhere on purpose is the strongest evidence
  // this module has; a stray history row is the weakest.
  it('ranks requested above library above playlist above history', () => {
    const requested = scoreOf({ sources: sources('requested') });
    const library = scoreOf({ sources: sources('library') });
    const playlist = scoreOf({ sources: sources('playlist') });
    const history = scoreOf({ sources: sources('history') });

    expect(requested).toBeGreaterThan(library);
    expect(library).toBeGreaterThan(playlist);
    expect(playlist).toBeGreaterThan(history);
  });

  /**
   * A Spotify save is the same act of curation as a local playlist entry, but
   * it was not saved *here* — it may be private listening rather than
   * something they would put on for a room. Below a playlist, far above a
   * history row nobody chose.
   */
  it('ranks a Spotify save between a local playlist and bare history', () => {
    const playlist = scoreOf({ sources: sources('playlist'), playlistRelevance: 1 });
    const spotify = scoreOf({ sources: sources('spotify') });
    const history = scoreOf({ sources: sources('history') });

    expect(playlist).toBeGreaterThan(spotify);
    expect(spotify).toBeGreaterThan(history);
  });

  /** One song on Spotify and in the local library is one song, scored at its best claim. */
  it('lets a library claim outrank a Spotify one on the same track', () => {
    const both = scoreOf({ sources: sources('spotify', 'library') });
    const libraryOnly = scoreOf({ sources: sources('library') });

    expect(both).toBeCloseTo(libraryOnly, 10);
  });

  it('takes the strongest claim when a track has several sources', () => {
    const both = scoreOf({ sources: sources('history', 'library') });
    const libraryOnly = scoreOf({ sources: sources('library') });

    expect(both).toBeCloseTo(libraryOnly, 10);
  });

  it('scales a playlist claim by how relevant the playlist is', () => {
    const starred = scoreOf({ sources: sources('playlist'), playlistRelevance: 1 });
    const forgotten = scoreOf({ sources: sources('playlist'), playlistRelevance: 0 });

    expect(starred).toBeGreaterThan(forgotten);
  });

  it('scores an unknown-provenance candidate at zero source trust', () => {
    const orphan = scoreFamiliar(candidate({ sources: sources() }), context());

    expect(signal(orphan, 'source')).toBe(0);
  });
});

describe('scoreFamiliar — listening evidence', () => {
  it('rewards a track the room replays', () => {
    expect(scoreOf({ plays: 6 })).toBeGreaterThan(scoreOf({ plays: 1 }));
  });

  it('rewards a track the room lets run to the end', () => {
    expect(scoreOf({ plays: 4, completions: 4 })).toBeGreaterThan(
      scoreOf({ plays: 4, completions: 0 }),
    );
  });

  it('rewards a track people actually ask for', () => {
    expect(scoreOf({ plays: 3, userPlays: 3 })).toBeGreaterThan(
      scoreOf({ plays: 3, userPlays: 0 }),
    );
  });

  it('rewards a track more than one listener has a claim on', () => {
    expect(scoreOf({ listenerCount: 3 })).toBeGreaterThan(scoreOf({ listenerCount: 1 }));
  });

  it('treats a never-played track as no opinion rather than a bad one', () => {
    const unplayed = scoreFamiliar(candidate({ plays: 0 }), context());

    expect(signal(unplayed, 'completion')).toBe(0.5);
  });
});

describe('scoreFamiliar — rejection', () => {
  it('penalises early skips', () => {
    expect(scoreOf({ plays: 4, earlySkips: 2 })).toBeLessThan(scoreOf({ plays: 4, earlySkips: 0 }));
  });

  it('penalises a pattern of skipping harder than a single skip', () => {
    const pattern = scoreFamiliar(
      candidate({ plays: 4, completions: 1, earlySkips: 3 }),
      context(),
    );
    const once = scoreFamiliar(candidate({ plays: 4, completions: 1, earlySkips: 1 }), context());

    expect(signal(pattern, 'skipPenalty')).toBeGreaterThanOrEqual(0.5);
    expect(signal(once, 'skipPenalty')).toBeLessThan(0.2);
    expect(pattern.score).toBeLessThan(once.score);
  });

  it('does not escalate when the track is finished more often than skipped', () => {
    const tolerated = scoreFamiliar(
      candidate({ plays: 6, completions: 4, earlySkips: 2 }),
      context(),
    );

    expect(signal(tolerated, 'skipPenalty')).toBeCloseTo(0.25, 10);
  });

  it('penalises a track skipped in this session', () => {
    const skipped = scoreFamiliar(
      candidate(),
      context({
        recent: {
          ...EMPTY_RECENT_CONTEXT,
          skippedKeys: [scoreFamiliar(candidate(), context()).trackKey],
        },
      }),
    );

    expect(signal(skipped, 'recentSkipPenalty')).toBeCloseTo(0.4, 10);
    expect(skipped.score).toBeLessThan(scoreOf({}));
  });

  it('penalises an artist the session has just been saturated with', () => {
    const entry = scoreFamiliar(candidate(), context());
    const fatigued = scoreFamiliar(
      candidate(),
      context({ artistFatigue: new Map([[entry.artistKey, 1]]) }),
    );

    expect(signal(fatigued, 'artistPenalty')).toBeCloseTo(0.3, 10);
    expect(fatigued.score).toBeLessThan(entry.score);
  });
});

describe('scoreFamiliar — context fit', () => {
  it('prefers a track by an artist the session is seeded with', () => {
    const entry = scoreFamiliar(candidate(), context());
    const seeded = scoreFamiliar(candidate(), context({ seedArtists: [entry.artistKey] }));

    expect(signal(seeded, 'context')).toBe(1);
    expect(seeded.score).toBeGreaterThan(entry.score);
  });

  it('decays the seed claim with how long ago the seed played', () => {
    const entry = scoreFamiliar(candidate(), context());
    const newest = scoreFamiliar(
      candidate(),
      context({ seedArtists: [entry.artistKey, 'x', 'y'] }),
    );
    const oldest = scoreFamiliar(
      candidate(),
      context({ seedArtists: ['a', 'b', 'c', 'd', entry.artistKey] }),
    );

    expect(newest.score).toBeGreaterThan(oldest.score);
    expect(signal(oldest, 'context')).toBeCloseTo(0.5, 10);
  });

  it('falls back to tag affinity when no seed matches', () => {
    const liked = scoreFamiliar(
      candidate({ tags: ['punjabi hip hop'] }),
      context({ profile: profile({ tagAffinity: { 'punjabi hip hop': 0.9 } }) }),
    );
    const disliked = scoreFamiliar(
      candidate({ tags: ['punjabi hip hop'] }),
      context({ profile: profile({ tagAffinity: { 'punjabi hip hop': -0.9 } }) }),
    );

    expect(signal(liked, 'context')).toBeGreaterThan(signal(disliked, 'context'));
  });

  it('rewards an artist the listener completes', () => {
    const entry = scoreFamiliar(candidate(), context());
    const liked = scoreFamiliar(
      candidate(),
      context({ profile: profile({ artistAffinity: { [entry.artistKey]: 0.9 } }) }),
    );

    expect(signal(liked, 'artistAffinity')).toBeGreaterThan(0.5);
    expect(liked.score).toBeGreaterThan(entry.score);
  });

  it('penalises a track whose language differs from the session', () => {
    const matching = scoreFamiliar(
      candidate({ tags: ['bollywood'] }),
      context({ sessionLanguage: 'hindi' }),
    );
    const mismatched = scoreFamiliar(
      candidate({ tags: ['k-pop'] }),
      context({ sessionLanguage: 'hindi' }),
    );

    expect(signal(mismatched, 'languagePenalty')).toBeCloseTo(0.35, 10);
    expect(signal(matching, 'languagePenalty')).toBe(0);
    expect(mismatched.score).toBeLessThan(matching.score);
  });

  it('leaves an unknown language unpunished', () => {
    const unknown = scoreFamiliar(
      candidate({ tags: ['chill'] }),
      context({ sessionLanguage: 'hindi' }),
    );

    expect(signal(unknown, 'languagePenalty')).toBe(0);
  });
});

describe('scoreFamiliar — rest', () => {
  it('refuses a track that played within the last two hours', () => {
    const justPlayed = scoreFamiliar(candidate({ lastPlayedAt: NOW - HOUR }), context());

    expect(signal(justPlayed, 'recencyRest')).toBe(0);
  });

  it('scores a rested track above a recently played one', () => {
    expect(scoreOf({ lastPlayedAt: NOW - 30 * HOUR })).toBeGreaterThan(
      scoreOf({ lastPlayedAt: NOW - HOUR }),
    );
  });

  it('treats a full day of rest as fully rested', () => {
    const rested = scoreFamiliar(candidate({ lastPlayedAt: NOW - 24 * HOUR }), context());

    expect(signal(rested, 'recencyRest')).toBe(1);
  });

  it('ramps between the floor and the ceiling', () => {
    const half = scoreFamiliar(candidate({ lastPlayedAt: NOW - 13 * HOUR }), context());

    expect(signal(half, 'recencyRest')).toBeGreaterThan(0);
    expect(signal(half, 'recencyRest')).toBeLessThan(1);
  });

  it('treats a track never played here as fresh but unverified', () => {
    const unplayed = scoreFamiliar(candidate({ lastPlayedAt: null }), context());

    expect(signal(unplayed, 'recencyRest')).toBeCloseTo(0.8, 10);
  });
});

describe('scoreFamiliar — bounds', () => {
  it('keeps the best possible candidate inside [0, 1]', () => {
    const best = scoreFamiliar(
      candidate({
        sources: sources('requested', 'library', 'playlist', 'history'),
        plays: 40,
        userPlays: 40,
        completions: 40,
        playlistRelevance: 1,
        listenerCount: 10,
        lastPlayedAt: NOW - 100 * HOUR,
      }),
      context({ profile: profile({ artistAffinity: { 'some artist': 1 } }), seedArtists: [] }),
    );

    expect(best.score).toBeGreaterThan(0);
    expect(best.score).toBeLessThanOrEqual(1);
  });

  it('never falls below zero however bad the candidate is', () => {
    const entry = scoreFamiliar(candidate(), context());
    const worst = scoreFamiliar(
      candidate({
        sources: sources(),
        plays: 5,
        completions: 0,
        earlySkips: 5,
        lastPlayedAt: NOW,
        listenerCount: 0,
        playlistRelevance: 0,
        tags: ['k-pop'],
      }),
      context({
        sessionLanguage: 'hindi',
        artistFatigue: new Map([[entry.artistKey, 1]]),
        recent: { ...EMPTY_RECENT_CONTEXT, skippedKeys: [entry.trackKey] },
      }),
    );

    expect(worst.score).toBe(0);
  });

  it('ignores nonsense counters instead of producing NaN', () => {
    const broken = scoreFamiliar(
      candidate({ plays: Number.NaN, completions: -3, listenerCount: Number.NaN }),
      context(),
    );

    expect(Number.isFinite(broken.score)).toBe(true);
    expect(broken.score).toBeGreaterThanOrEqual(0);
  });
});

describe('explainFamiliar', () => {
  it('reports every signal and the penalties that fired', () => {
    const entry = scoreFamiliar(candidate(), context());
    const explanation = explainFamiliar(
      scoreFamiliar(
        candidate({ plays: 4, completions: 0, earlySkips: 3 }),
        context({ artistFatigue: new Map([[entry.artistKey, 1]]) }),
      ),
    );

    expect(explanation).toContain('source');
    expect(explanation).toContain('replay');
    expect(explanation).toContain('completion');
    expect(explanation).toContain('requested');
    expect(explanation).toContain('affinity');
    expect(explanation).toContain('context');
    expect(explanation).toContain('rest');
    expect(explanation).toContain('listeners');
    expect(explanation).toContain('-skips');
    expect(explanation).toContain('-artist');
  });

  it('omits penalties that did not fire', () => {
    const explanation = explainFamiliar(scoreFamiliar(candidate(), context()));

    expect(explanation).not.toContain('-skips');
    expect(explanation).not.toContain('-language');
  });
});
