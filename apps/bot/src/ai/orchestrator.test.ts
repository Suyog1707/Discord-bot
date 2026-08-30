import { describe, expect, it, vi } from 'vitest';

import type { CacheService } from './cache.js';
import { IntentService } from './intent.js';
import type { LastFmService } from './lastfm.js';
import { NULL_PROVIDER } from './llm/provider.js';
import type { MusicBrainzService } from './musicbrainz.js';
import { MusicOrchestrator, type InformSources } from './orchestrator.js';
import type { RecommendationService } from './recommender.js';
import type { UserTasteService } from './taste.js';

/**
 * The orchestrator with a heuristic intent parser (no LLM) and every other
 * collaborator faked at its seam. `ask()` must never reach the recommender or
 * any resolver on its own — that is the whole point of the separation.
 */
function orchestrator(inform?: Partial<InformSources>) {
  const recommend = vi.fn();
  const rank = vi.fn();
  const artistTags = vi.fn(() => Promise.resolve(['bollywood', 'romantic']));
  const similarArtists = vi.fn(() => Promise.resolve(['Atif Aslam', 'Armaan Malik']));
  const profile = vi.fn(() =>
    Promise.resolve({
      genres: ['bollywood'],
      language: { value: 'hindi', confidence: 'high' },
      releaseYear: 2013,
    }),
  );
  const instance = new MusicOrchestrator({
    intent: new IntentService(NULL_PROVIDER),
    taste: {} as UserTasteService,
    recommender: { recommend, rank } as unknown as RecommendationService,
    lastfm: { enabled: false } as LastFmService,
    musicbrainz: {} as MusicBrainzService,
    cache: {} as CacheService,
    inform: { artistTags, similarArtists, profile, ...inform },
  });
  return { instance, recommend, rank, artistTags, similarArtists, profile };
}

describe('MusicOrchestrator.ask — questions are answered, not played', () => {
  it('answers "what genre is this" from metadata about the playing track without any resolver', async () => {
    const o = orchestrator();

    const outcome = await o.instance.ask({
      guildId: 'g',
      text: 'what genre is this song?',
      seeds: [],
      current: { title: 'Tum Hi Ho', artist: 'Arijit Singh' },
    });

    expect(outcome.plan.kind).toBe('inform');
    if (outcome.plan.kind !== 'inform') return;
    expect(outcome.plan.answer).toContain('Tum Hi Ho');
    expect(outcome.plan.answer).toContain('bollywood');
    expect(outcome.plan.answer).toContain('hindi');
    expect(outcome.plan.answer).toContain('2013');
    expect(o.profile).toHaveBeenCalledWith({ title: 'Tum Hi Ho', artist: 'Arijit Singh' });
    expect(o.recommend).not.toHaveBeenCalled();
    expect(o.rank).not.toHaveBeenCalled();
  });

  it('answers "which artists are similar to X" about the named subject', async () => {
    const o = orchestrator();

    const outcome = await o.instance.ask({
      guildId: 'g',
      text: 'which artists are similar to Arijit Singh',
      seeds: [],
    });

    expect(outcome.plan.kind).toBe('inform');
    if (outcome.plan.kind !== 'inform') return;
    expect(o.similarArtists).toHaveBeenCalledWith('Arijit Singh');
    expect(outcome.plan.answer).toContain('Atif Aslam');
    // A named subject with no title is not a track: no profile lookup.
    expect(o.profile).not.toHaveBeenCalled();
  });

  it('explains when a question about "this" has nothing playing', async () => {
    const o = orchestrator();
    const outcome = await o.instance.ask({ guildId: 'g', text: 'who sings this?', seeds: [] });
    expect(outcome.plan.kind).toBe('inform');
    if (outcome.plan.kind !== 'inform') return;
    expect(outcome.plan.answer).toMatch(/nothing is playing/iu);
  });

  it('turns a mood request into a recommend plan without resolving anything itself', async () => {
    const o = orchestrator();
    const outcome = await o.instance.ask({ guildId: 'g', text: 'play something chill', seeds: [] });
    expect(outcome.plan.kind).toBe('recommend');
    expect(outcome.intent.mood).toContain('chill');
    expect(o.recommend).not.toHaveBeenCalled();
  });

  it('turns an unclassifiable request into a direct lookup for the caller', async () => {
    const o = orchestrator();
    const outcome = await o.instance.ask({ guildId: 'g', text: 'blinding lights', seeds: [] });
    expect(outcome.plan).toEqual({ kind: 'direct', query: 'blinding lights' });
  });
});
