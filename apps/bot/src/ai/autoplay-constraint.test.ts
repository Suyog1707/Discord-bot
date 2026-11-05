/**
 * The seed constraint: autoplay continues in the language AND the style
 * (rap / non-rap) of the song the listener asked for.
 *
 * Three layers are pinned here, smallest first:
 *  - the pure tag readers (`styleFromTags`, `languageFromArtistTags`),
 *  - the pure verdict for one candidate (`judgeCandidate`),
 *  - the resolver's classification, which combines provider, track tags,
 *    title script, artist tags and — for the seed only — the room's history.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  judgeCandidate,
  languageFromArtistTags,
  styleFromTags,
  UNKNOWN_CLASSIFICATION,
  type Classification,
  type ConstraintContext,
} from './autoplay-constraint.js';
import { CacheService } from './cache.js';
import { identityOf } from './identity.js';
import { TrackProfileResolver, type TagSource } from './track-profile.js';

/* ------------------------------------------------------------------ fixtures */

/** A tag world: artist tags by artist name, track tags by title. */
function tagSource(
  artists: Readonly<Record<string, readonly string[]>>,
  tracks: Readonly<Record<string, readonly string[]>> = {},
) {
  const artistTags = vi.fn((artist: string) => Promise.resolve(artists[artist] ?? []));
  const trackTags = vi.fn((_artist: string, title: string) => Promise.resolve(tracks[title] ?? []));
  const source: TagSource = { artistTags, trackTags };
  return { source, artistTags, trackTags };
}

function resolverFor(
  artists: Readonly<Record<string, readonly string[]>>,
  tracks: Readonly<Record<string, readonly string[]>> = {},
) {
  const world = tagSource(artists, tracks);
  return { ...world, resolver: new TrackProfileResolver(world.source, new CacheService()) };
}

function cls(
  language: string | null,
  style: Classification['style'] = null,
  confidence: Classification['confidence'] = language === null ? 'none' : 'medium',
): Classification {
  return { language, style, confidence, sources: [] };
}

const SEED_ARTIST = identityOf('Seed Artist', 'x').artistKey;
const LINKED_ARTIST = identityOf('Linked Artist', 'x').artistKey;
const STRANGER = identityOf('Stranger', 'x').artistKey;

function context(seed: Classification): ConstraintContext {
  return {
    seed,
    seedArtistKeys: new Set([SEED_ARTIST]),
    linkedArtistKeys: new Set([LINKED_ARTIST]),
  };
}

const NO_HISTORY = { sameArtist: [], coplayed: [] } as const;

/* ------------------------------------------------------------- styleFromTags */

describe('styleFromTags', () => {
  it.each([
    [['hip hop', 'desi hip hop', 'hindi', 'indian'], 'rap'],
    [['hindi rap'], 'rap'],
    [['pop rap'], 'rap'],
    [['drill', 'uk'], 'rap'],
    [['trap'], 'rap'],
    [['bollywood', 'indian', 'hindi', 'romantic', 'sufi'], 'non-rap'],
    [['pop', 'british', 'singer-songwriter'], 'non-rap'],
    [['rock', 'british', 'alternative'], 'non-rap'],
    [['filmi'], 'non-rap'],
  ] as const)('%j reads as %s', (tags, style) => {
    expect(styleFromTags(tags)).toBe(style);
  });

  it('stays unknown when no tag names a style', () => {
    expect(styleFromTags([])).toBeNull();
    expect(styleFromTags(['indian', 'hindi'])).toBeNull();
  });

  it('stays unknown on an even split rather than guessing', () => {
    expect(styleFromTags(['bollywood', 'hip hop'])).toBeNull();
  });

  it('matches whole words, so "therapy" is not rap', () => {
    expect(styleFromTags(['therapy'])).toBeNull();
  });
});

/* ---------------------------------------------------- languageFromArtistTags */

describe('languageFromArtistTags', () => {
  it('takes a language-specific artist tag for a romanized title', () => {
    expect(languageFromArtistTags(['hip hop', 'desi hip hop', 'hindi'], 'Khatta Flow')).toBe(
      'hindi',
    );
    expect(languageFromArtistTags(['bollywood', 'filmi'], 'Tum Hi Ho')).toBe('hindi');
  });

  it('refuses an artist tagged with two different languages', () => {
    expect(languageFromArtistTags(['punjabi', 'bollywood'], 'Lover')).toBeNull();
  });

  it('refuses a nationality or scene tag on its own', () => {
    expect(languageFromArtistTags(['desi hip hop', 'indian'], 'Khatta Flow')).toBeNull();
    expect(languageFromArtistTags(['american'], 'Some Song')).toBeNull();
  });

  it('reads English from an anglophone artist with real genre tags and a Latin title', () => {
    expect(languageFromArtistTags(['pop', 'british', 'singer-songwriter'], 'Perfect')).toBe(
      'english',
    );
    expect(languageFromArtistTags(['rnb', 'canadian', 'pop'], 'Blinding Lights')).toBe('english');
  });

  it('does not call it English when another language or region is in the tags', () => {
    expect(languageFromArtistTags(['pop', 'american', 'latin'], 'Despacito')).toBeNull();
    expect(languageFromArtistTags(['pop', 'british', 'indian'], 'Song')).toBeNull();
  });

  it('does not call a non-Latin title English', () => {
    expect(languageFromArtistTags(['rnb', 'canadian', 'pop'], 'साथ')).toBeNull();
  });

  it('pins a Devanagari title to Marathi when the artist says Marathi', () => {
    expect(languageFromArtistTags(['marathi'], 'मराठी गाणे')).toBe('marathi');
  });
});

/* ------------------------------------------------------------ judgeCandidate */

describe('judgeCandidate', () => {
  it('excludes a known different language', () => {
    expect(judgeCandidate(cls('hindi'), STRANGER, context(cls('english')))).toBe('language');
    // Even the seed's own artist cannot cross a known language line.
    expect(judgeCandidate(cls('hindi'), SEED_ARTIST, context(cls('english')))).toBe('language');
  });

  it('excludes a known different style when the seed style is known', () => {
    const seed = cls('hindi', 'rap');
    expect(judgeCandidate(cls('hindi', 'non-rap'), STRANGER, context(seed))).toBe('style');
    expect(judgeCandidate(cls('hindi', 'rap'), STRANGER, context(seed))).toBe('allow');
  });

  it('does not constrain style when the seed style is unknown', () => {
    expect(judgeCandidate(cls('hindi', 'rap'), STRANGER, context(cls('hindi')))).toBe('allow');
  });

  it('allows an unknown style only with a link to the seed', () => {
    const seed = cls('hindi', 'rap');
    expect(judgeCandidate(cls('hindi'), STRANGER, context(seed))).toBe('unlinked');
    expect(judgeCandidate(cls('hindi'), LINKED_ARTIST, context(seed))).toBe('allow');
    expect(judgeCandidate(cls('hindi'), SEED_ARTIST, context(seed))).toBe('allow');
  });

  it('allows an unknown language only with a link to the seed', () => {
    const seed = cls('english', 'non-rap');
    expect(judgeCandidate(cls(null), STRANGER, context(seed))).toBe('unlinked');
    expect(judgeCandidate(cls(null), SEED_ARTIST, context(seed))).toBe('allow');
  });

  it('restricts an unknown seed to the same and linked artists', () => {
    const seed = cls(null);
    expect(judgeCandidate(cls('english', 'non-rap'), STRANGER, context(seed))).toBe('unlinked');
    expect(judgeCandidate(cls('english', 'non-rap'), LINKED_ARTIST, context(seed))).toBe('allow');
    expect(judgeCandidate(cls(null), SEED_ARTIST, context(seed))).toBe('allow');
  });

  it('still applies a known seed style when only the language is unknown', () => {
    const seed = cls(null, 'rap');
    expect(judgeCandidate(cls(null, 'non-rap'), LINKED_ARTIST, context(seed))).toBe('style');
  });

  it('treats a low-confidence language as unknown', () => {
    // A nationality-only guess must never exclude anything.
    expect(
      judgeCandidate(cls(null, null, 'low'), SEED_ARTIST, context(cls('english', null, 'high'))),
    ).toBe('allow');
  });
});

/* --------------------------------------------- TrackProfileResolver.autoplayClass */

describe('TrackProfileResolver.autoplayClass', () => {
  it('classifies Hindi rap from the artist when the romanized title has no tags', async () => {
    const { resolver } = resolverFor({
      'Seedhe Maut': ['hip hop', 'desi hip hop', 'hindi', 'indian'],
    });
    const result = await resolver.autoplayClass({ title: 'Khatta Flow', artist: 'Seedhe Maut' });
    expect(result.language).toBe('hindi');
    expect(result.style).toBe('rap');
    expect(result.sources).toContain('artist-tags');
  });

  it('classifies normal Hindi from a filmi artist', async () => {
    const { resolver } = resolverFor({ 'Arijit Singh': ['bollywood', 'filmi', 'romantic'] });
    const result = await resolver.autoplayClass({ title: 'Tum Hi Ho', artist: 'Arijit Singh' });
    expect(result).toMatchObject({ language: 'hindi', style: 'non-rap' });
  });

  it('lets the track tags outrank the artist tags', async () => {
    const { resolver } = resolverFor({ Singer: ['hindi', 'bollywood'] }, { Gaane: ['marathi'] });
    const result = await resolver.autoplayClass({ title: 'Gaane', artist: 'Singer' });
    expect(result).toMatchObject({ language: 'marathi', confidence: 'high' });
    expect(result.sources).toContain('track-tags');
  });

  it('takes a provider language over everything else', async () => {
    const { resolver } = resolverFor({ Singer: ['punjabi'] });
    const result = await resolver.autoplayClass({
      title: 'Song',
      artist: 'Singer',
      providerLanguage: 'hi',
    });
    expect(result).toMatchObject({ language: 'hindi', confidence: 'high' });
    expect(result.sources).toContain('provider');
  });

  it('reads a distinctive script without any lookup evidence', async () => {
    const { resolver } = resolverFor({});
    const result = await resolver.autoplayClass({ title: 'ਸੋਹਣਾ', artist: 'Singer' });
    expect(result.language).toBe('punjabi');
    expect(result.sources).toContain('script');
  });

  it('does not call a bare Devanagari title Hindi (it could be Marathi)', async () => {
    const { resolver } = resolverFor({});
    expect((await resolver.autoplayClass({ title: 'मराठी गाणे', artist: 'Singer' })).language).toBe(
      null,
    );
  });

  it('lets the artist pin a Devanagari title to Marathi or Hindi', async () => {
    const { resolver } = resolverFor({ 'Marathi Singer': ['marathi'], 'Hindi Singer': ['hindi'] });
    expect(
      (await resolver.autoplayClass({ title: 'मराठी गाणे', artist: 'Marathi Singer' })).language,
    ).toBe('marathi');
    expect(
      (await resolver.autoplayClass({ title: 'तुम ही हो', artist: 'Hindi Singer' })).language,
    ).toBe('hindi');
  });

  it('fails closed, without throwing, when every lookup fails', async () => {
    const resolver = new TrackProfileResolver(
      {
        artistTags: () => Promise.reject(new Error('offline')),
        trackTags: () => Promise.reject(new Error('offline')),
      },
      new CacheService(),
    );
    const result = await resolver.autoplayClass({ title: 'Song', artist: 'Singer' });
    expect(result.language).toBeNull();
    expect(result.style).toBeNull();
  });

  it('looks each artist up once, however many of their songs are classified', async () => {
    const { resolver, artistTags } = resolverFor({ 'Seedhe Maut': ['desi hip hop', 'hindi'] });
    await resolver.autoplayClass({ title: 'Khatta Flow', artist: 'Seedhe Maut' });
    await resolver.autoplayClass({ title: 'Nanchaku', artist: 'Seedhe Maut' });
    await resolver.autoplayClass({ title: 'Nanchaku', artist: 'Seedhe Maut' });
    expect(artistTags).toHaveBeenCalledTimes(1);
  });

  it('exports an all-unknown constant for callers that have no resolver', () => {
    expect(UNKNOWN_CLASSIFICATION).toMatchObject({ language: null, style: null });
  });
});

/* ----------------------------------------- TrackProfileResolver.autoplaySeedClass */

describe('TrackProfileResolver.autoplaySeedClass', () => {
  it('returns the plain classification when it is already conclusive', async () => {
    const { resolver } = resolverFor({ 'Seedhe Maut': ['desi hip hop', 'hindi', 'hip hop'] });
    const result = await resolver.autoplaySeedClass(
      { title: 'Khatta Flow', artist: 'Seedhe Maut' },
      NO_HISTORY,
    );
    expect(result).toMatchObject({ language: 'hindi', style: 'rap' });
  });

  it("learns a romanized seed's language and style from the artist's other songs", async () => {
    // No artist tags at all; one of the artist's other songs the room played
    // carries track tags naming both the language and the style.
    const { resolver } = resolverFor({}, { Nanchaku: ['hindi', 'hip hop'] });
    const result = await resolver.autoplaySeedClass(
      { title: 'Khatta Flow', artist: 'Seedhe Maut' },
      { sameArtist: [{ title: 'Nanchaku', artist: 'Seedhe Maut' }], coplayed: [] },
    );
    expect(result).toMatchObject({ language: 'hindi', style: 'rap' });
    expect(result.sources).toContain('history');
  });

  it('stays unknown when the artist history disagrees with itself', async () => {
    const { resolver } = resolverFor({}, { One: ['hindi'], Two: ['punjabi'] });
    const result = await resolver.autoplaySeedClass(
      { title: 'Seed', artist: 'Singer' },
      {
        sameArtist: [
          { title: 'One', artist: 'Singer' },
          { title: 'Two', artist: 'Singer' },
        ],
        coplayed: [],
      },
    );
    expect(result.language).toBeNull();
  });

  it('uses strongly co-played songs only when they agree', async () => {
    const { resolver } = resolverFor({}, { A: ['english', 'pop'], B: ['english', 'rock'] });
    const agreed = await resolver.autoplaySeedClass(
      { title: 'Seed', artist: 'Unknown Act' },
      {
        sameArtist: [],
        coplayed: [
          { title: 'A', artist: 'Band A', weight: 0.9 },
          { title: 'B', artist: 'Band B', weight: 0.8 },
        ],
      },
    );
    expect(agreed.language).toBe('english');
    expect(agreed.sources).toContain('cooccurrence');
  });

  it('ignores weakly co-played songs', async () => {
    const { resolver } = resolverFor({}, { A: ['english'], B: ['english'] });
    const weak = await resolver.autoplaySeedClass(
      { title: 'Seed', artist: 'Unknown Act' },
      {
        sameArtist: [],
        coplayed: [
          { title: 'A', artist: 'Band A', weight: 0.1 },
          { title: 'B', artist: 'Band B', weight: 0.2 },
        ],
      },
    );
    expect(weak.language).toBeNull();
  });
});
