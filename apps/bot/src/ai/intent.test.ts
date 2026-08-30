import { describe, expect, it, vi } from 'vitest';

import { IntentService, parseIntentHeuristically } from './intent.js';
import type { LLMProvider } from './llm/provider.js';

function provider(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    name: 'test',
    available: true,
    complete: vi.fn(),
    ...overrides,
  };
}

function completion(text: string): LLMProvider {
  return provider({
    complete: vi.fn().mockResolvedValue({ text, model: 'test', latencyMs: 1 }),
  });
}

describe('parseIntentHeuristically', () => {
  it('reads a quantity out of a playlist request', () => {
    expect(parseIntentHeuristically('queue 250 songs').quantity).toBe(250);
    expect(parseIntentHeuristically('make me a playlist of 100 tracks').quantity).toBe(100);
  });

  it('caps an absurd quantity instead of accepting it', () => {
    expect(parseIntentHeuristically('queue 9999 songs').quantity).toBe(1_000);
  });

  it('defaults the quantity when none is stated', () => {
    expect(parseIntentHeuristically('play something chill').quantity).toBe(10);
  });

  it('extracts moods', () => {
    expect(parseIntentHeuristically('play something chill').mood).toContain('chill');
    expect(parseIntentHeuristically('songs for studying').mood).toContain('study');
    expect(parseIntentHeuristically('gym music').mood).toContain('workout');
  });

  it('extracts a stated language', () => {
    expect(parseIntentHeuristically('play some hindi songs').language).toBe('hindi');
    expect(parseIntentHeuristically('punjabi tracks please').language).toBe('punjabi');
  });

  it('does not invent a language that was never stated', () => {
    expect(parseIntentHeuristically('play something chill').language).toBeNull();
  });

  it('recognises a taste-continuation request', () => {
    expect(parseIntentHeuristically('more like this').intent).toBe('continue_taste');
    expect(parseIntentHeuristically('keep the vibe going').intent).toBe('continue_taste');
  });

  it('sets avoidRecent for freshness requests', () => {
    expect(parseIntentHeuristically("songs I haven't heard recently").avoidRecent).toBe(true);
    expect(parseIntentHeuristically('play some hindi songs').avoidRecent).toBe(false);
  });

  it('keeps artist diversity on unless the user pins one artist', () => {
    expect(parseIntentHeuristically('play something similar').artistDiversity).toBe(true);
    expect(parseIntentHeuristically('only this artist please').artistDiversity).toBe(false);
  });
});

describe('IntentService', () => {
  it('uses the model when it returns a valid object', async () => {
    const service = new IntentService(
      completion('{"intent":"recommend","mood":["chill"],"language":"hindi","quantity":25}'),
    );
    const result = await service.parse('play chill hindi songs, about 25');

    expect(result.source).toBe('llm');
    expect(result.intent.mood).toEqual(['chill']);
    expect(result.intent.language).toBe('hindi');
    expect(result.intent.quantity).toBe(25);
  });

  it('fills missing fields from defaults rather than rejecting a partial object', async () => {
    const service = new IntentService(completion('{"mood":["chill"]}'));
    const result = await service.parse('chill stuff');

    expect(result.source).toBe('llm');
    expect(result.intent.quantity).toBe(10);
    expect(result.intent.artistDiversity).toBe(true);
  });

  it('unwraps a fenced response', async () => {
    const service = new IntentService(
      completion('```json\n{"intent":"recommend","quantity":5}\n```'),
    );
    const result = await service.parse('five songs');

    expect(result.source).toBe('llm');
    expect(result.intent.quantity).toBe(5);
  });

  // The failsafe requirement: the model being down must not cost the user a queue.
  it('falls back to the heuristic parser when the provider throws', async () => {
    const service = new IntentService(
      provider({ complete: vi.fn().mockRejectedValue(new Error('rate limited')) }),
    );
    const result = await service.parse('queue 250 chill hindi songs');

    expect(result.source).toBe('heuristic');
    expect(result.intent.quantity).toBe(250);
    expect(result.intent.language).toBe('hindi');
  });

  it('falls back when the model returns prose instead of JSON', async () => {
    const service = new IntentService(completion('Sure! I can help you with that.'));
    const result = await service.parse('play something energetic');

    expect(result.source).toBe('heuristic');
    expect(result.intent.mood).toContain('energetic');
  });

  it('skips the model entirely when no provider is configured', async () => {
    const complete = vi.fn();
    const service = new IntentService(provider({ available: false, complete }));
    const result = await service.parse('play something chill');

    expect(result.source).toBe('heuristic');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('parseIntentHeuristically — questions', () => {
  it('reads a question as inform with the named subject', () => {
    const intent = parseIntentHeuristically('who is similar to Karan Aujla?');
    expect(intent.intent).toBe('inform');
    expect(intent.query).toBe('Karan Aujla');
  });

  it('reads a question about the playing track as inform with no subject', () => {
    expect(parseIntentHeuristically('what genre is this').query).toBeNull();
    expect(parseIntentHeuristically('what genre is this').intent).toBe('inform');
  });

  it('does not mistake a play request with a mood for a question', () => {
    expect(parseIntentHeuristically('play something chill').intent).toBe('recommend');
  });
});
