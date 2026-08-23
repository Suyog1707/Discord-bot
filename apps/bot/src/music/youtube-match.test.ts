import { describe, expect, it } from 'vitest';

import {
  CONFIDENT_SCORE,
  queryPlan,
  rankCandidates,
  REJECT_BELOW,
  scoreCandidate,
  type MatchCandidate,
  type WantedTrack,
} from './youtube-match.js';

let seq = 0;
function candidate(
  title: string,
  author: string,
  durationMs: number,
  isStream = false,
): MatchCandidate {
  seq += 1;
  return { title, author, durationMs, isStream, identifier: `id-${String(seq)}` };
}

/** The winner's title, for readable assertions. */
function winnerOf(wanted: WantedTrack, candidates: readonly MatchCandidate[]): string {
  const [best] = rankCandidates(wanted, candidates);
  return best?.candidate.title ?? '(none)';
}

describe('scoreCandidate', () => {
  const wanted: WantedTrack = {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    durationMs: 200_000,
    album: 'After Hours',
  };

  it('rates a Topic upload as confident on its own', () => {
    const { score } = scoreCandidate(
      wanted,
      candidate('Blinding Lights', 'The Weeknd - Topic', 200_000),
    );
    expect(score).toBeGreaterThanOrEqual(CONFIDENT_SCORE);
  });

  it('rejects a livestream outright', () => {
    const { score } = scoreCandidate(
      wanted,
      candidate('Blinding Lights 24/7 radio', 'Some Channel', 0, true),
    );
    expect(score).toBeLessThan(REJECT_BELOW);
  });

  it('scores a reaction video below the rejection floor', () => {
    const { score } = scoreCandidate(
      wanted,
      candidate('Blinding Lights REACTION!!', 'React Channel', 480_000),
    );
    expect(score).toBeLessThan(REJECT_BELOW);
  });
});

describe('ranking picks the release', () => {
  it('prefers official audio over a movie scene for a soundtrack song', () => {
    // The trap: the album IS the film, so the film name is legitimately in the
    // wanted metadata and the scene's title matches it well.
    const wanted: WantedTrack = {
      title: 'Naatu Naatu',
      artist: 'Rahul Sipligunj, Kaala Bhairava',
      durationMs: 275_000,
      album: 'RRR',
    };
    const winner = winnerOf(wanted, [
      candidate('RRR - Naatu Naatu Full Movie Scene | Best Scene', 'Movie Clips India', 412_000),
      candidate('Naatu Naatu (Official Audio) - RRR', 'Rahul Sipligunj - Topic', 275_000),
      candidate('Naatu Naatu Dance Reaction', 'ReactBros', 610_000),
    ]);
    expect(winner).toBe('Naatu Naatu (Official Audio) - RRR');
  });

  it('prefers official audio over the official music video', () => {
    const wanted: WantedTrack = {
      title: 'Loser',
      artist: 'Tame Impala',
      durationMs: 230_000,
      album: null,
    };
    const winner = winnerOf(wanted, [
      candidate('Tame Impala - Loser (Official Video)', 'tameimpalaVEVO', 230_000),
      candidate('Loser (Official Audio)', 'Tame Impala - Topic', 230_000),
    ]);
    expect(winner).toBe('Loser (Official Audio)');
  });

  it('does not take the live version when Spotify named the studio one', () => {
    const wanted: WantedTrack = {
      title: 'Someone Like You',
      artist: 'Adele',
      durationMs: 285_000,
      album: '21',
    };
    const winner = winnerOf(wanted, [
      candidate('Adele - Someone Like You (Live at the BRITs)', 'AdeleVEVO', 288_000),
      candidate('Someone Like You', 'Adele - Topic', 285_000),
    ]);
    expect(winner).toBe('Someone Like You');
  });

  it('does take the live version when Spotify named a live recording', () => {
    const wanted: WantedTrack = {
      title: 'Someone Like You - Live at the BRITs',
      artist: 'Adele',
      durationMs: 288_000,
      album: null,
    };
    const winner = winnerOf(wanted, [
      candidate('Someone Like You', 'Adele - Topic', 285_000),
      candidate('Adele - Someone Like You (Live at the BRITs)', 'AdeleVEVO', 288_000),
    ]);
    expect(winner).toBe('Adele - Someone Like You (Live at the BRITs)');
  });

  it('keeps a remix on the remix', () => {
    const wanted: WantedTrack = {
      title: 'Levitating (Remix)',
      artist: 'Dua Lipa, DaBaby',
      durationMs: 203_000,
      album: null,
    };
    const winner = winnerOf(wanted, [
      candidate('Dua Lipa - Levitating (Official Audio)', 'Dua Lipa - Topic', 203_000),
      candidate(
        'Dua Lipa - Levitating feat. DaBaby (Official Remix Audio)',
        'DuaLipaVEVO',
        203_000,
      ),
    ]);
    expect(winner).toBe('Dua Lipa - Levitating feat. DaBaby (Official Remix Audio)');
  });

  it('rejects a fan cover in favour of the original', () => {
    const wanted: WantedTrack = {
      title: 'Yellow',
      artist: 'Coldplay',
      durationMs: 266_000,
      album: 'Parachutes',
    };
    const winner = winnerOf(wanted, [
      candidate('Yellow - Coldplay (Cover by Jane Doe)', 'Jane Doe Music', 266_000),
      candidate('Yellow', 'Coldplay - Topic', 266_000),
    ]);
    expect(winner).toBe('Yellow');
  });

  it('matches a collaboration uploaded under the lead artist alone', () => {
    const wanted: WantedTrack = {
      title: 'Sunflower',
      artist: 'Post Malone, Swae Lee',
      durationMs: 158_000,
      album: 'Spider-Man: Into the Spider-Verse',
    };
    const winner = winnerOf(wanted, [
      // The trap again: the album is a film, and this is a scene from it.
      candidate('Spider-Man Into the Spider-Verse - Best Scene', 'Movie Moments', 190_000),
      candidate('Sunflower', 'Post Malone - Topic', 158_000),
    ]);
    expect(winner).toBe('Sunflower');
  });

  it('rejects a short even when its title is a perfect match', () => {
    const wanted: WantedTrack = {
      title: 'Flowers',
      artist: 'Miley Cyrus',
      durationMs: 200_000,
      album: null,
    };
    const winner = winnerOf(wanted, [
      candidate('Flowers - Miley Cyrus #shorts', 'Clips Daily', 45_000),
      candidate('Flowers', 'Miley Cyrus - Topic', 200_000),
    ]);
    expect(winner).toBe('Flowers');
  });

  it('separates two different songs sharing a title by artist and duration', () => {
    const wanted: WantedTrack = {
      title: 'Wildest Dreams',
      artist: 'Taylor Swift',
      durationMs: 220_000,
      album: '1989',
    };
    const winner = winnerOf(wanted, [
      candidate('Wildest Dreams', 'Duomo - Topic', 195_000),
      candidate('Wildest Dreams', 'Taylor Swift - Topic', 220_000),
    ]);
    expect(winner).toBe('Wildest Dreams');
    const [best] = rankCandidates(wanted, [
      candidate('Wildest Dreams', 'Duomo - Topic', 195_000),
      candidate('Wildest Dreams', 'Taylor Swift - Topic', 220_000),
    ]);
    expect(best?.candidate.author).toBe('Taylor Swift - Topic');
  });

  it('prefers a plain upload over a lyric video', () => {
    const wanted: WantedTrack = {
      title: 'Something',
      artist: 'Some Artist',
      durationMs: 210_000,
      album: null,
    };
    const winner = winnerOf(wanted, [
      candidate('Something - Some Artist (Lyrics)', 'LyricsChannel', 210_000),
      candidate('Something (Official Audio)', 'Some Artist - Topic', 210_000),
    ]);
    expect(winner).toBe('Something (Official Audio)');
  });

  it('does not punish a song legitimately titled with a penalised word', () => {
    // "Scene" is the song. Nothing here is a movie clip, and the release must
    // still win comfortably rather than being dragged under by its own name.
    const wanted: WantedTrack = {
      title: 'Love Scene',
      artist: 'Some Artist',
      durationMs: 200_000,
      album: null,
    };
    const [best] = rankCandidates(wanted, [
      candidate('Love Scene', 'Some Artist - Topic', 200_000),
    ]);
    expect(best?.score).toBeGreaterThan(0);
  });

  it('beats a lyrics reupload cut to the exact runtime', () => {
    // Found against live search. A lyrics channel is the audio and nothing
    // else, so it matches the track length exactly, while the artist's own
    // music video carries an intro and credits. On runtime alone the reupload
    // wins; attribution is what settles it.
    const wanted: WantedTrack = {
      title: 'Loser',
      artist: 'Tame Impala',
      durationMs: 223_069,
      album: 'Loser',
    };
    const winner = winnerOf(wanted, [
      candidate('Tame Impala - Loser (Lyrics)', 'Cakes & Eclairs', 223_000),
      candidate('Tame Impala - Loser (Official Video)', 'Tame Impala', 268_000),
    ]);
    expect(winner).toBe('Tame Impala - Loser (Official Video)');
  });

  it('is not fooled by an aggregator channel claiming the word "official"', () => {
    // "OfficialMovieSoundtrack" outscored the artist's own upload purely on a
    // channel-name bonus, which is why only Topic/VEVO/artist-name attribute.
    const wanted: WantedTrack = {
      title: 'Loser',
      artist: 'Tame Impala',
      durationMs: 223_069,
      album: 'Loser',
    };
    const winner = winnerOf(wanted, [
      candidate('Loser - Tame Impala (Spider-Man Soundtrack)', 'OfficialMovieSoundtrack', 224_000),
      candidate('Tame Impala - Loser (Official Video)', 'Tame Impala', 268_000),
    ]);
    expect(winner).toBe('Tame Impala - Loser (Official Video)');
  });

  it('tolerates music-video framing but not a truncated clip', () => {
    const wanted: WantedTrack = {
      title: 'Song',
      artist: 'Artist',
      durationMs: 200_000,
      album: null,
    };
    const longer = scoreCandidate(wanted, candidate('Song', 'Artist - Topic', 250_000));
    const shorter = scoreCandidate(wanted, candidate('Song', 'Artist - Topic', 172_000));
    expect(longer.score).toBeGreaterThan(shorter.score);
  });

  it('falls back to the least-bad option rather than nothing', () => {
    const wanted: WantedTrack = {
      title: 'Obscure Song',
      artist: 'Unknown Artist',
      durationMs: 200_000,
      album: null,
    };
    const [best] = rankCandidates(wanted, [candidate('Obscure Song', 'randomuploader91', 201_000)]);
    expect(best?.score).toBeGreaterThan(REJECT_BELOW);
  });
});

describe('queryPlan', () => {
  const wanted: WantedTrack = {
    title: 'Sunflower',
    artist: 'Post Malone, Swae Lee',
    durationMs: 158_000,
    album: null,
  };

  it('leads with the plain query the old code used', () => {
    expect(queryPlan(wanted)[0]).toBe('Sunflower Post Malone, Swae Lee');
  });

  it('offers official-audio, topic and lead-artist fallbacks', () => {
    const plan = queryPlan(wanted).join(' | ');
    expect(plan).toContain('official audio');
    expect(plan).toContain('topic');
    expect(plan).toContain('official music video');
  });

  it('produces no duplicate queries for a single-artist track', () => {
    const plan = queryPlan({
      title: 'Yellow',
      artist: 'Coldplay',
      durationMs: 266_000,
      album: null,
    });
    expect(new Set(plan).size).toBe(plan.length);
  });
});
