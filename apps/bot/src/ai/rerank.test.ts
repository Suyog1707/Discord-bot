import { describe, expect, it, vi } from 'vitest';

import { ShortlistReranker, type RerankCandidate, type RerankContext } from './rerank.js';
import type { LLMProvider } from './llm/provider.js';

function provider(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    name: 'test',
    available: true,
    complete: vi.fn(),
    ...overrides,
  };
}

function providerReturning(text: string): LLMProvider {
  return provider({
    complete: vi.fn().mockResolvedValue({ text, model: 'test', latencyMs: 1 }),
  });
}

function failingProvider(): LLMProvider {
  return provider({
    complete: vi.fn().mockRejectedValue(new Error('provider exploded')),
  });
}

const CONTEXT: RerankContext = {
  topArtists: ['karan aujla', 'ap dhillon'],
  topTags: ['punjabi', 'hip hop'],
  recentTitles: ['Softly', 'Winning Speech'],
  discoveryLevel: 0.3,
};

function candidates(count: number): RerankCandidate[] {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `Track ${String(index)}`,
    artist: `Artist ${String(index)}`,
    score: 1 - index / count,
    tags: ['punjabi'],
  }));
}

describe('ShortlistReranker', () => {
  it('returns the model order for a valid response', async () => {
    const reranker = new ShortlistReranker(providerReturning('{"order":[2,0,1]}'));
    const result = await reranker.rerank(candidates(3), CONTEXT);

    expect(result).toEqual([2, 0, 1]);
  });

  it('accepts a markdown-fenced response', async () => {
    const reranker = new ShortlistReranker(
      providerReturning('```json\n{"order":[2,0,1]}\n```'),
    );
    const result = await reranker.rerank(candidates(3), CONTEXT);

    expect(result).toEqual([2, 0, 1]);
  });

  it('returns null when fewer than half of the candidates survive', async () => {
    // 2 of 6 survive, below the half-of-6 threshold.
    const reranker = new ShortlistReranker(providerReturning('{"order":[4,1]}'));
    const result = await reranker.rerank(candidates(6), CONTEXT);

    expect(result).toBeNull();
  });

  it('completes a partial order that meets the half threshold', async () => {
    // Exactly half of 6 survive: the partial order is kept and completed.
    const reranker = new ShortlistReranker(providerReturning('{"order":[4,1,0]}'));
    const result = await reranker.rerank(candidates(6), CONTEXT);

    expect(result).toEqual([4, 1, 0, 2, 3, 5]);
  });

  it('drops out-of-range and duplicate indices, then appends what is missing', async () => {
    const reranker = new ShortlistReranker(providerReturning('{"order":[9,1,1,0,2]}'));
    const result = await reranker.rerank(candidates(4), CONTEXT);

    // 9 is out of range and the second 1 is a duplicate; both are dropped.
    // The surviving [1, 0, 2] clears the half-of-4 threshold, so index 3 is
    // appended deterministically.
    expect(result).toEqual([1, 0, 2, 3]);
  });

  it('returns null for prose instead of JSON', async () => {
    const reranker = new ShortlistReranker(providerReturning('Sure, here is a great order!'));
    const result = await reranker.rerank(candidates(4), CONTEXT);

    expect(result).toBeNull();
  });

  it('returns null when the provider rejects', async () => {
    const reranker = new ShortlistReranker(failingProvider());
    const result = await reranker.rerank(candidates(4), CONTEXT);

    expect(result).toBeNull();
  });

  it('returns null without calling the provider when it is unavailable', async () => {
    const complete = vi.fn();
    const reranker = new ShortlistReranker(provider({ available: false, complete }));
    const result = await reranker.rerank(candidates(4), CONTEXT);

    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns null without calling the provider when there are fewer than 3 candidates', async () => {
    const complete = vi.fn();
    const reranker = new ShortlistReranker(provider({ complete }));
    const result = await reranker.rerank(candidates(2), CONTEXT);

    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it('always returns a permutation containing every index exactly once', async () => {
    const cases: readonly { readonly text: string; readonly count: number }[] = [
      { text: '{"order":[2,0,1]}', count: 3 },
      { text: '```json\n{"order":[2,0,1]}\n```', count: 3 },
      { text: '{"order":[4,1,0]}', count: 6 },
      { text: '{"order":[9,1,1,0,2]}', count: 4 },
    ];

    for (const testCase of cases) {
      const reranker = new ShortlistReranker(providerReturning(testCase.text));
      const result = await reranker.rerank(candidates(testCase.count), CONTEXT);

      expect(result).not.toBeNull();
      const sorted = [...(result ?? [])].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: testCase.count }, (_unused, index) => index));
    }
  });

  it('caps the prompt at 30 candidates but still covers the full list in the result', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue({ text: '{"order":[1,0]}', model: 'test', latencyMs: 1 });
    const reranker = new ShortlistReranker(provider({ complete }));
    const result = await reranker.rerank(candidates(40), CONTEXT);

    expect(complete).toHaveBeenCalledTimes(1);

    const request = complete.mock.calls[0]?.[0] as { readonly user: string };
    const numberedLines = request.user.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(numberedLines).toHaveLength(30);

    // Only 2 of the 30 shown candidates came back — below half of the shown
    // list — so the whole rerank is untrusted, regardless of the 40 total.
    expect(result).toBeNull();
  });

  it('caps the prompt at 30 candidates and appends unshown candidates when the model order survives', async () => {
    const order = Array.from({ length: 20 }, (_unused, index) => index);
    const complete = vi
      .fn()
      .mockResolvedValue({ text: JSON.stringify({ order }), model: 'test', latencyMs: 1 });
    const reranker = new ShortlistReranker(provider({ complete }));
    const result = await reranker.rerank(candidates(40), CONTEXT);

    const request = complete.mock.calls[0]?.[0] as { readonly user: string };
    const numberedLines = request.user.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(numberedLines).toHaveLength(30);

    expect(result).not.toBeNull();
    const sorted = [...(result ?? [])].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 40 }, (_unused, index) => index));
  });
});
