import { describe, expect, it } from 'vitest';

import { canonicalTrack, type CanonicalTrack } from './canonical-track.js';
import {
  isAcceptable,
  isConfident,
  queryPlan,
  rankCandidates,
  requestedVariantsOf,
  scoreCandidate,
  type MatchCandidate,
  type MatchOptions,
} from './candidate-matcher.js';
import {
  DEFAULT_DURATION_RULES,
  SOUNDCLOUD_WEIGHTS,
  YOUTUBE_WEIGHTS,
} from './match-config.js';

let seq = 0;
function candidate(
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

function options(overrides: Partial<MatchOptions> = {}): MatchOptions {
  return {
    provider: 'youtube',
    weights: YOUTUBE_WEIGHTS,
    duration: DEFAULT_DURATION_RULES,
    ...overrides,
  };
}

const youtube = options();
const soundcloud = options({ provider: 'soundcloud', weights: SOUNDCLOUD_WEIGHTS });

/** The winner's title, for readable assertions. */
function winnerOf(
  track: CanonicalTrack,
  candidates: readonly MatchCandidate[],
  opts: MatchOptions = youtube,
): string {
  const [best] = rankCandidates(track, candidates, opts);
  return best?.rejected === null ? best.candidate.title : '(none)';
}

describe('scoreCandidate — attribution and confidence', () => {
  it('rates a Topic upload as confident on its own', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
      youtube,
    );
    expect(entry.authoritative).toBe(true);
    expect(isConfident(entry, YOUTUBE_WEIGHTS)).toBe(true);
  });

  it('treats an ISRC agreement as decisive', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'SomeUploader', 200_000, { isrc: 'us-um7-19-00028' }),
      youtube,
    );
    expect(entry.reasons.join(' ')).toContain('isrc-match');
    expect(isAcceptable(entry, YOUTUBE_WEIGHTS)).toBe(true);
  });

  it('vetoes a candidate whose ISRC names a different recording', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000, { isrc: 'GBUM71029604' }),
      youtube,
    );
    expect(entry.rejected?.kind).toBe('isrc-conflict');
    expect(isAcceptable(entry, YOUTUBE_WEIGHTS)).toBe(false);
  });

  it('reads a SoundCloud uploader that is the artist as attribution', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd', 200_000),
      soundcloud,
    );
    expect(entry.authoritative).toBe(true);
    expect(isAcceptable(entry, SOUNDCLOUD_WEIGHTS)).toBe(true);
  });
});

describe('scoreCandidate — rejections', () => {
  it('rejects a livestream outright', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights 24/7 radio', 'Some Channel', 0, { isStream: true }),
      youtube,
    );
    expect(entry.rejected?.kind).toBe('stream');
  });

  it('rejects a reaction video', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights REACTION!!', 'React Channel', 480_000),
      youtube,
    );
    expect(entry.rejected?.kind).toBe('non-music');
  });

  it.each([
    ['Blinding Lights Movie Scene', 'Film Clips HD'],
    ['After Hours - Best Scene', 'MovieClips'],
    ['Blinding Lights | Official Trailer', 'Paramount'],
    ['Blinding Lights Dialogue Promo', 'TV Channel'],
  ])('rejects %s as not a music release', (title, author) => {
    const entry = scoreCandidate(wanted, candidate(title, author, 200_000), youtube);
    expect(entry.rejected?.kind).toBe('non-music');
  });

  it('rejects a candidate several times the length of the recording', () => {
    // A twelve-minute upload for a 3:20 song is a mix, an album or a film —
    // never the song, however well the title matches.
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd - Topic', 750_000),
      youtube,
    );
    expect(entry.rejected?.kind).toBe('duration');
  });

  it('rejects an unrelated result that merely shares a word', () => {
    const entry = scoreCandidate(
      wanted,
      candidate('Northern Lights', 'Some Producer', 195_000),
      youtube,
    );
    expect(isAcceptable(entry, YOUTUBE_WEIGHTS)).toBe(false);
  });

  it('does not veto a release for matching its own name', () => {
    // A recording the catalogue calls "Love Scene" must not be rejected by the
    // rule that exists to catch film excerpts.
    const loveScene = canonicalTrack({
      title: 'Love Scene',
      artist: 'Beabadoobee',
      durationMs: 190_000,
      provider: 'spotify',
    });
    const entry = scoreCandidate(
      loveScene,
      candidate('Love Scene', 'beabadoobee - Topic', 190_000),
      youtube,
    );
    expect(entry.rejected).toBeNull();
    expect(isAcceptable(entry, YOUTUBE_WEIGHTS)).toBe(true);
  });

  it('rejects a clean-titled film upload on accumulated suspicion alone', () => {
    // Nothing in the title gives this away: no "scene", no "clip". It is caught
    // by everything being slightly wrong at once — a clips channel, a runtime
    // outside tolerance, no attribution to the artist.
    const entry = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'Bollywood Movies Zone', 262_000),
      youtube,
    );
    expect(entry.rejected?.kind).toBe('non-music');
    expect(entry.rejected?.detail).toContain('composite');
  });
});

describe('rankCandidates — choosing between plausible uploads', () => {
  it('prefers the official audio over a movie scene with the same runtime', () => {
    const winner = winnerOf(wanted, [
      candidate('Blinding Lights Scene | After Hours', 'Movie Clips', 200_000),
      candidate('Blinding Lights (Official Audio)', 'The Weeknd - Topic', 200_000),
    ]);
    expect(winner).toBe('Blinding Lights (Official Audio)');
  });

  it('prefers the original over an unrequested remix', () => {
    const winner = winnerOf(wanted, [
      candidate('Blinding Lights (Chill Remix)', 'RemixCentral', 201_000),
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
    ]);
    expect(winner).toBe('Blinding Lights');
  });

  it('allows the remix when the user explicitly asked for one', () => {
    const requestedVariants = requestedVariantsOf('blinding lights remix');
    expect([...requestedVariants]).toEqual(['remix']);

    const winner = winnerOf(
      wanted,
      [
        candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
        candidate('Blinding Lights (Chill Remix)', 'RemixCentral', 201_000),
      ],
      options({ requestedVariants }),
    );
    expect(winner).toBe('Blinding Lights (Chill Remix)');
  });

  it('prefers the studio recording over a live take nobody asked for', () => {
    const winner = winnerOf(wanted, [
      candidate('Blinding Lights (Live at the Super Bowl)', 'The Weeknd - Topic', 205_000),
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
    ]);
    expect(winner).toBe('Blinding Lights');
  });

  it('prefers the live take when the catalogue named the live recording', () => {
    const live = canonicalTrack({
      title: 'Blinding Lights (Live)',
      artist: 'The Weeknd',
      durationMs: 205_000,
      provider: 'spotify',
    });
    const winner = winnerOf(live, [
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
      candidate('Blinding Lights (Live)', 'The Weeknd - Topic', 205_000),
    ]);
    expect(winner).toBe('Blinding Lights (Live)');
  });

  it('picks the closest runtime between otherwise identical uploads', () => {
    const winner = winnerOf(wanted, [
      candidate('Blinding Lights', 'The Weeknd - Topic', 214_000),
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_500),
    ]);
    const [best] = rankCandidates(
      wanted,
      [
        candidate('Blinding Lights', 'The Weeknd - Topic', 214_000),
        candidate('Blinding Lights', 'The Weeknd - Topic', 200_500),
      ],
      youtube,
    );
    expect(winner).toBe('Blinding Lights');
    expect(best?.candidate.durationMs).toBe(200_500);
  });

  it('prefers the attributed upload over a lyrics reupload cut to the exact runtime', () => {
    const [best] = rankCandidates(
      wanted,
      [
        candidate('Blinding Lights [Lyrics]', 'LyricVault', 200_000),
        candidate('Blinding Lights (Official Video)', 'TheWeekndVEVO', 240_000),
      ],
      youtube,
    );
    expect(best?.candidate.author).toBe('TheWeekndVEVO');
  });
});

describe('duration tolerance', () => {
  it('is configurable', () => {
    const tight = options({ duration: { ...DEFAULT_DURATION_RULES, toleranceMs: 3_000 } });
    const loose = options({ duration: { ...DEFAULT_DURATION_RULES, toleranceMs: 30_000 } });
    const near = candidate('Blinding Lights', 'Some Uploader', 210_000);

    const tightScore = scoreCandidate(wanted, near, tight).score;
    const looseScore = scoreCandidate(wanted, near, loose).score;
    expect(looseScore).toBeGreaterThan(tightScore);
  });

  it('treats a few seconds either way as the same recording', () => {
    const exact = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd - Topic', 199_000),
      youtube,
    );
    expect(exact.reasons.join(' ')).toContain('duration-exact');
  });
});

describe('queryPlan', () => {
  it('leads with the ISRC on YouTube when one is known', () => {
    expect(queryPlan(wanted, 'youtube')[0]).toBe('USUM71900028');
  });

  it('widens rather than decorates on SoundCloud', () => {
    const plan = queryPlan(wanted, 'soundcloud');
    expect(plan[0]).toBe('Blinding Lights The Weeknd');
    expect(plan).toContain('Blinding Lights');
    expect(plan.some((query) => query.includes('topic'))).toBe(false);
  });

  it('ends with a lyrics query on YouTube, never earlier', () => {
    const plan = queryPlan(wanted, 'youtube');
    expect(plan[plan.length - 1]).toContain('lyrics');
  });
});

describe('requestedVariantsOf', () => {
  it.each([
    ['song x remix', 'remix'],
    ['song x live', 'live'],
    ['song x acoustic', 'acoustic'],
    ['song x instrumental', 'instrumental'],
    ['song x slowed reverb', 'slowed'],
    ['song x sped up', 'sped-up'],
  ])('reads %s as a request for the %s version', (query, marker) => {
    expect([...requestedVariantsOf(query)]).toContain(marker);
  });

  it('finds nothing in a plain request', () => {
    expect(requestedVariantsOf('blinding lights the weeknd').size).toBe(0);
  });
});
