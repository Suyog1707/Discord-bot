/**
 * Reordering, not deciding.
 *
 * By the time a shortlist reaches this file, the recommendation engine has
 * already filtered and scored it — every candidate here already passed the
 * rules that decide what is even allowed to play. This reranker's only job is
 * to hand back a permutation of that list: indices into the array it was
 * given, nothing else. Because the response format has no room for anything
 * but an index, the model is structurally incapable of introducing a song
 * that was excluded upstream or duplicating one that already appears — there
 * is no field a hallucinated title could occupy.
 *
 * This is the second (and last) thing in the recommendation stack that calls
 * an LLM — the first is intent parsing. One call per rerank, never per song:
 * sequencing thirty candidates costs one round trip, not thirty.
 *
 * Any failure — the provider unavailable, a rejected or timed-out call,
 * unparseable JSON, indices that don't fit the shortlist, too few of them to
 * trust — returns null rather than throwing. The caller already has a
 * deterministic order from the scorer; losing the reranker just means keeping
 * it.
 */
import { z } from 'zod';

import { getLogger } from '../lib/logger.js';

import { extractJson } from './intent.js';
import type { LLMProvider } from './llm/provider.js';

const logger = getLogger('rerank');

/** Below this many candidates there is nothing meaningful to reorder. */
const MIN_CANDIDATES = 3;

/**
 * Only the head of the shortlist is sent to the model. Anything past this
 * many candidates was already scored low enough that it never gets picked in
 * practice, so spending prompt tokens ranking it buys nothing.
 */
const MAX_CANDIDATES_SENT = 30;

export interface RerankCandidate {
  readonly title: string;
  readonly artist: string;
  /** Deterministic score 0..1 the engine already computed. */
  readonly score: number;
  readonly tags?: readonly string[];
}

export interface RerankContext {
  /** e.g. ['karan aujla', 'ap dhillon'] — the listener's top artists. */
  readonly topArtists: readonly string[];
  /** e.g. ['punjabi', 'hip hop'] — dominant profile tags. */
  readonly topTags: readonly string[];
  /** Titles of the last few tracks played, newest first. */
  readonly recentTitles: readonly string[];
  /** 0..1 — how much exploration the session currently wants. */
  readonly discoveryLevel: number;
}

const rerankResponseSchema = z.object({
  order: z.array(z.number()),
});

const SYSTEM_PROMPT = `You sequence a shortlist of already-approved songs for a personalised radio
queue. The list is fixed: you may only reorder it, never add, remove, rename
or invent a song. Respond with the object only — no prose, no markdown fence:
{"order": [numbers]} — zero-based indices into the candidate list, in your
chosen play order. You may omit entries you are unsure about.

Weigh, in roughly this priority:
- Taste fit: favour songs whose artist or tags match the listener's top
  artists and top tags.
- Recency: avoid placing a song too close to a near-repeat of itself and
  avoid stacking several tracks by the same artist back to back, using the
  recently played titles as the reference.
- Sequencing: order songs so mood and energy flow reasonably from one track
  to the next rather than jumping at random.
- Discovery budget: the given discoveryLevel is the share of the ordering
  that should surface less-familiar, lower-score picks instead of only the
  safest, highest-score ones.`;

/** Human-readable "none" beats an empty list when the model has to read it. */
function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function formatContext(context: RerankContext): string {
  return [
    `Top artists: ${formatList(context.topArtists)}`,
    `Top tags: ${formatList(context.topTags)}`,
    `Recently played, newest first: ${formatList(context.recentTitles)}`,
    `Discovery level: ${context.discoveryLevel.toFixed(2)}`,
  ].join('\n');
}

function buildUserMessage(candidates: readonly RerankCandidate[], context: RerankContext): string {
  const lines = candidates.map((candidate, index) => {
    const tags = candidate.tags !== undefined && candidate.tags.length > 0 ? candidate.tags.join(', ') : 'none';
    return `${String(index)}. ${candidate.artist} — ${candidate.title} (score ${candidate.score.toFixed(2)}; tags: ${tags})`;
  });

  return [...lines, '', formatContext(context)].join('\n');
}

/**
 * Turn whatever indices the model returned into a full, safe permutation.
 *
 * Only integers within `[0, headLength)` — the slice actually shown to the
 * model — can survive; anything else is silently dropped rather than
 * rejected wholesale, since a model that gets one index wrong usually got the
 * rest right. If fewer than half of the shown candidates come back the model
 * clearly did not understand the task, and the caller is better off with
 * null than with a mostly-guessed order. Otherwise every index the model
 * missed — including the tail beyond `headLength` that it never saw — is
 * appended in the engine's original, deterministic order.
 */
function sanitiseOrder(
  rawOrder: readonly number[],
  headLength: number,
  totalLength: number,
): readonly number[] | null {
  const seen = new Set<number>();
  const kept: number[] = [];

  for (const value of rawOrder) {
    if (!Number.isInteger(value)) continue;
    if (value < 0 || value >= headLength) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    kept.push(value);
  }

  if (kept.length < headLength / 2) return null;

  for (let index = 0; index < totalLength; index += 1) {
    if (!seen.has(index)) kept.push(index);
  }

  return kept;
}

export class ShortlistReranker {
  readonly #provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.#provider = provider;
  }

  /**
   * Returns a permutation of `[0..candidates.length)` — possibly a partial
   * ordering from the model, completed deterministically — or null when the
   * model could not help. Never throws.
   */
  async rerank(
    candidates: readonly RerankCandidate[],
    context: RerankContext,
  ): Promise<readonly number[] | null> {
    if (!this.#provider.available || candidates.length < MIN_CANDIDATES) return null;

    const head = candidates.slice(0, MAX_CANDIDATES_SENT);

    let text: string;
    try {
      const result = await this.#provider.complete({
        system: SYSTEM_PROMPT,
        user: buildUserMessage(head, context),
        json: true,
        maxTokens: 300,
      });
      text = result.text;
    } catch (error) {
      logger.debug({ err: error, provider: this.#provider.name }, 'Rerank call failed');
      return null;
    }

    const parsed = rerankResponseSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      logger.debug({ provider: this.#provider.name }, 'Rerank response did not match schema');
      return null;
    }

    const order = sanitiseOrder(parsed.data.order, head.length, candidates.length);
    if (order === null) {
      logger.debug({ provider: this.#provider.name }, 'Rerank order too sparse to trust');
    }
    return order;
  }
}
