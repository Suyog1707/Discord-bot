/**
 * Turning a canonical recording into something that can actually be streamed.
 *
 * The playback layer's whole contract is this file: given a track that the
 * metadata layer has already identified, find the upload that most accurately
 * IS that recording — or return nothing.
 *
 * Provider order is SoundCloud first, YouTube second, and the reason is not
 * that SoundCloud's catalogue is better. It is that SoundCloud's catalogue is
 * *only music*. Everything in it is an upload someone published as audio, so
 * the worst realistic wrong answer there is a bootleg remix. YouTube's index
 * contains the film the song is from, the trailer for that film, three
 * reactions to the trailer and a fourteen-minute explanation of the ending —
 * all of which are excellent results for the query and none of which are the
 * song. Asking the quieter catalogue first means the noisy one is only consulted
 * for the tracks the quiet one genuinely does not have, and it is consulted
 * under stricter rules when it is.
 *
 * "First" is about whose answer wins, not about waiting in line. The quieter
 * catalogue gets a head start and the final say; the noisier one is started
 * alongside it as soon as the quiet one is unsure, so a fall-through no longer
 * pays for every SoundCloud query before YouTube has even been asked.
 *
 * Falling through both is a legitimate outcome. Nothing here will play a
 * low-confidence match because something had to be played: a wrong song is a
 * worse answer than an honest "no reliable version found", and it is also a
 * much harder failure for a listener to diagnose.
 */
import { getLogger } from '../lib/logger.js';
import { canonicalKey, describeCanonical, type CanonicalTrack } from './canonical-track.js';
import {
  isAcceptable,
  isConfident,
  queryPlan,
  rankCandidates,
  type MatchCandidate,
  type MatchOptions,
  type PlaybackProvider,
  type ScoredCandidate,
} from './candidate-matcher.js';
import {
  DEFAULT_DURATION_RULES,
  SOUNDCLOUD_WEIGHTS,
  YOUTUBE_WEIGHTS,
  type DurationRules,
  type MatchWeights,
} from './match-config.js';

const logger = getLogger('resolver');

/** The architecture's default priority. Overridable per call and by configuration. */
export const DEFAULT_PROVIDER_ORDER: readonly PlaybackProvider[] = ['soundcloud', 'youtube'];

/**
 * How long a provider searches alone before the next one is started alongside
 * it, even if it has not said it is unsure yet.
 *
 * About one upstream search's worth. Shorter, and YouTube would be asked for
 * nearly every track SoundCloud answers perfectly well; longer, and a slow
 * SoundCloud answer becomes a wait nobody needed to have.
 */
export const PROVIDER_HEAD_START_MS = 700;

/** How many of a provider's queries run together after its first. */
const QUERY_BATCH_SIZE = 2;

/**
 * Search one playback provider.
 *
 * Injected rather than imported so this module never depends on Lavalink: the
 * resolution policy is the valuable part and it is worth being able to test it
 * without an audio server, exactly as `platform-links` does for its lookups.
 *
 * Implementations should return the provider's own result list, unfiltered and
 * in the provider's own order — every filtering and ordering decision belongs
 * here, where the canonical track is in scope.
 */
export type ProviderSearch<T extends MatchCandidate> = (
  query: string,
  provider: PlaybackProvider,
) => Promise<readonly T[]>;

export interface ResolvedPlayback<T extends MatchCandidate> {
  readonly candidate: T;
  readonly provider: PlaybackProvider;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly authoritative: boolean;
}

/** What one provider was asked and what it answered. Kept for the log. */
export interface ProviderAttempt {
  readonly provider: PlaybackProvider;
  readonly queriesRun: number;
  readonly considered: number;
  /** Up to a handful of the most interesting refusals, best-scoring first. */
  readonly rejected: readonly { readonly title: string; readonly reason: string }[];
  readonly best: {
    readonly title: string;
    readonly author: string;
    readonly score: number;
    readonly why: string;
  } | null;
  readonly decision: 'play' | 'below-threshold' | 'no-candidates' | 'provider-error';
  readonly error?: string;
}

/** The full story of one resolution, for diagnosing a bad match after the fact. */
export interface ResolutionTrace {
  readonly track: string;
  readonly artist: string;
  readonly isrc: string | null;
  readonly durationMs: number;
  readonly metadataProvider: string;
  readonly requestedVariants: readonly string[];
  readonly attempts: readonly ProviderAttempt[];
  readonly decision: 'play' | 'no-match' | 'cached';
  readonly playedFrom: PlaybackProvider | null;
  readonly cached: boolean;
}

export interface ResolveOptions<T extends MatchCandidate = MatchCandidate> {
  /** Version markers the user asked for explicitly — see `requestedVariantsOf`. */
  readonly requestedVariants?: ReadonlySet<string> | undefined;
  /** Provider priority. Defaults to {@link DEFAULT_PROVIDER_ORDER}. */
  readonly order?: readonly PlaybackProvider[] | undefined;
  readonly weights?: Partial<Record<PlaybackProvider, MatchWeights>> | undefined;
  readonly duration?: DurationRules | undefined;
  readonly officialChannelTokens?: readonly string[] | undefined;
  /** Overrides both profiles' accept threshold. Used by autoplay, which has no runtime to match. */
  readonly acceptScore?: number | undefined;
  readonly cache?: ResolutionCache<T> | undefined;
  /**
   * How long a provider searches alone before the next starts alongside it.
   * Defaults to {@link PROVIDER_HEAD_START_MS}.
   */
  readonly headStartMs?: number | undefined;
}

const DEFAULT_WEIGHTS: Record<PlaybackProvider, MatchWeights> = {
  soundcloud: SOUNDCLOUD_WEIGHTS,
  youtube: YOUTUBE_WEIGHTS,
};

/**
 * Memoises successful, confident resolutions by canonical identity.
 *
 * Keyed through `canonicalKey`, so an ISRC-identified track is one entry no
 * matter which catalogue described it. Only accepted matches are ever stored:
 * caching a low-confidence result would turn one bad match into a permanently
 * bad match, and re-running the search is cheap by comparison.
 *
 * Generic in the candidate type and owned by the caller rather than living at
 * module scope — a shared untyped cache across generic instantiations is how a
 * "playable track" quietly becomes something else.
 */
export class ResolutionCache<T extends MatchCandidate> {
  readonly #entries = new Map<
    string,
    { readonly value: ResolvedPlayback<T>; readonly expiresAt: number }
  >();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(ttlMs = 6 * 60 * 60_000, maxEntries = 2_000) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get(key: string): ResolvedPlayback<T> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: ResolvedPlayback<T>): void {
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Apply a caller's accept-score override without disturbing the rest of a profile. */
function withAcceptScore(weights: MatchWeights, acceptScore: number | undefined): MatchWeights {
  if (acceptScore === undefined) return weights;
  return {
    ...weights,
    acceptScore,
    // The attribution gate is expressed as a score band, so lowering the accept
    // threshold beneath it would make the gate cover the entire accepted range
    // and reject everything unattributed. It moves with the threshold.
    attributionRequiredBelow: Math.min(weights.attributionRequiredBelow, acceptScore),
  };
}

/** How the provider walk steers one provider's search. */
interface SearchControl {
  /** Not confident yet: the next provider should start alongside this one. */
  readonly onUnsure: () => void;
  /** An answer has already been chosen; searching further buys nothing. */
  readonly isStopped: () => boolean;
}

type ProviderOutcome<T extends MatchCandidate> =
  | {
      readonly kind: 'searched';
      readonly ranked: readonly ScoredCandidate<T>[];
      readonly queriesRun: number;
      readonly pooled: number;
    }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Search one provider through its query plan, stopping once a winner is certain.
 *
 * The first query runs alone: for an unambiguous track it is the only one ever
 * needed, and a second alongside it would be load for nothing. What follows
 * runs in pairs. Those are the tracks the first query got wrong — soundtracks,
 * collaborations, titles that are also films — where the plan is long and
 * waiting on each search in turn was most of the delay.
 */
async function searchProvider<T extends MatchCandidate>(
  wanted: CanonicalTrack,
  provider: PlaybackProvider,
  search: ProviderSearch<T>,
  matchOptions: MatchOptions,
  control: SearchControl,
): Promise<{
  readonly ranked: readonly ScoredCandidate<T>[];
  readonly queriesRun: number;
  readonly pooled: number;
}> {
  const seen = new Set<string>();
  const pool: T[] = [];
  let ranked: readonly ScoredCandidate<T>[] = [];
  let queriesRun = 0;

  const plan = queryPlan(wanted, provider);
  let next = 0;
  while (next < plan.length && !control.isStopped()) {
    const batch = plan.slice(next, next + (next === 0 ? 1 : QUERY_BATCH_SIZE));
    next += batch.length;
    queriesRun += batch.length;

    // Merged in plan order, so the pool — and any tie in the ranking — is the
    // same whichever search in the batch happens to answer first.
    const answers = await Promise.all(batch.map(async (query) => search(query, provider)));
    for (const result of answers.flat()) {
      if (seen.has(result.identifier)) continue;
      seen.add(result.identifier);
      pool.push(result);
    }
    if (pool.length === 0) {
      control.onUnsure();
      continue;
    }

    // Re-ranked over the whole accumulated pool rather than per query: a result
    // that appears in three searches is scored once, and each extra query only
    // widens the field it is judged against.
    ranked = rankCandidates(wanted, pool, matchOptions);
    if (isConfident(ranked[0], matchOptions.weights)) break;
    control.onUnsure();
  }

  return { ranked, queriesRun, pooled: pool.length };
}

function summariseRejections<T extends MatchCandidate>(
  ranked: readonly ScoredCandidate<T>[],
): readonly { readonly title: string; readonly reason: string }[] {
  return ranked
    .filter((entry) => entry.rejected !== null)
    .slice(0, 5)
    .map((entry) => ({
      title: `${entry.candidate.author} — ${entry.candidate.title}`,
      reason: `${entry.rejected?.kind ?? 'unknown'}: ${entry.rejected?.detail ?? ''}`,
    }));
}

/**
 * Resolve a canonical recording to a playable upload.
 *
 * Walks the provider order, and returns the first provider's winner that clears
 * that provider's confidence threshold. A provider that throws is logged and
 * skipped — an outage on the primary must fall through to the fallback, not
 * fail the request.
 *
 * @returns The accepted match, or null when no provider produced one. Null is a
 *   real answer here and callers are expected to surface it as "no reliable
 *   version found" rather than substituting something else.
 */
export async function resolvePlayback<T extends MatchCandidate>(
  wanted: CanonicalTrack,
  search: ProviderSearch<T>,
  options: ResolveOptions<T> = {},
): Promise<{ readonly result: ResolvedPlayback<T> | null; readonly trace: ResolutionTrace }> {
  const order = options.order ?? DEFAULT_PROVIDER_ORDER;
  const duration = options.duration ?? DEFAULT_DURATION_RULES;
  const cache = options.cache;
  const key = canonicalKey(wanted);

  const baseTrace = {
    track: wanted.title,
    artist: wanted.primaryArtist,
    isrc: wanted.isrc,
    durationMs: wanted.durationMs,
    metadataProvider: wanted.provider,
    requestedVariants: [...(options.requestedVariants ?? [])],
  };

  const cached = cache?.get(key);
  // A cache hit only counts when it names a provider this call is willing to
  // use. Without that check, pinning the walk to one provider — which is how
  // `/play source:` and stream recovery both work — would hand back an entry
  // resolved against a provider the caller deliberately excluded.
  if (cached !== undefined && order.includes(cached.provider)) {
    return {
      result: cached,
      trace: {
        ...baseTrace,
        attempts: [],
        decision: 'cached',
        playedFrom: cached.provider,
        cached: true,
      },
    };
  }

  const attempts: ProviderAttempt[] = [];

  /**
   * Providers in order of preference — but not one after another.
   *
   * Each provider gets a head start, and the next begins alongside it the
   * moment it is unsure (a search that came back without a confident winner)
   * or when the head start runs out, whichever is first. Decisions are still
   * taken strictly in order: a later provider's answer is used only once every
   * earlier provider has given up, so the quieter catalogue keeps its priority.
   * What changes is that falling through no longer waits for the whole of the
   * earlier provider's query plan before the next one has even been asked.
   *
   * Once an answer is chosen, providers still searching stop before their next
   * query.
   */
  const stopped = { value: false };
  const headStartMs = options.headStartMs ?? PROVIDER_HEAD_START_MS;

  const runs = order.map((provider) => {
    let open = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      provider,
      weights: withAcceptScore(
        options.weights?.[provider] ?? DEFAULT_WEIGHTS[provider],
        options.acceptScore,
      ),
      start: (): void => {
        open();
      },
      started,
    };
  });

  const outcomes = runs.map(async (run, index): Promise<ProviderOutcome<T>> => {
    await run.started;
    const startNext = (): void => {
      runs[index + 1]?.start();
    };
    const headStart = setTimeout(startNext, headStartMs);
    headStart.unref();

    const matchOptions: MatchOptions = {
      provider: run.provider,
      weights: run.weights,
      duration,
      requestedVariants: options.requestedVariants,
      officialChannelTokens: options.officialChannelTokens,
    };
    try {
      const searched = await searchProvider(wanted, run.provider, search, matchOptions, {
        onUnsure: startNext,
        isStopped: () => stopped.value,
      });
      return { kind: 'searched', ...searched };
    } catch (error) {
      // An outage is as unsure as a provider gets: the next one should not
      // sit out the rest of the head start.
      startNext();
      return { kind: 'failed', error };
    } finally {
      clearTimeout(headStart);
    }
  });
  runs[0]?.start();

  for (const [index, run] of runs.entries()) {
    const { provider, weights } = run;
    // Normally running already. This covers a provider whose predecessor ended
    // without ever saying it was unsure — an empty query plan, say.
    run.start();
    const outcome = await outcomes[index];
    if (outcome === undefined) continue;

    if (outcome.kind === 'failed') {
      // A provider outage is not a resolution failure. Record it and move on to
      // the next one; only exhausting the whole order is a failure.
      attempts.push({
        provider,
        queriesRun: 0,
        considered: 0,
        rejected: [],
        best: null,
        decision: 'provider-error',
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
      logger.warn(
        { err: outcome.error, provider, track: describeCanonical(wanted) },
        'Playback provider failed',
      );
      continue;
    }
    const { ranked, queriesRun, pooled } = outcome;

    const best = ranked.find((entry) => entry.rejected === null);
    const attempt: ProviderAttempt = {
      provider,
      queriesRun,
      considered: pooled,
      rejected: summariseRejections(ranked),
      best:
        best === undefined
          ? null
          : {
              title: best.candidate.title,
              author: best.candidate.author,
              score: best.score,
              why: best.reasons.join(' '),
            },
      decision: isAcceptable(best, weights)
        ? 'play'
        : best === undefined
          ? 'no-candidates'
          : 'below-threshold',
    };
    attempts.push(attempt);

    if (attempt.decision === 'play' && best !== undefined) {
      // Anything still searching stops before its next query.
      stopped.value = true;
      const result: ResolvedPlayback<T> = {
        candidate: best.candidate,
        provider,
        score: best.score,
        reasons: best.reasons,
        authoritative: best.authoritative,
      };
      // Only accepted matches are cached — see `ResolutionCache`.
      cache?.set(key, result);
      const trace: ResolutionTrace = {
        ...baseTrace,
        attempts,
        decision: 'play',
        playedFrom: provider,
        cached: false,
      };
      logResolution(trace);
      return { result, trace };
    }
  }

  const trace: ResolutionTrace = {
    ...baseTrace,
    attempts,
    decision: 'no-match',
    playedFrom: null,
    cached: false,
  };
  logResolution(trace);
  return { result: null, trace };
}

/**
 * Render a trace the way a person reads it.
 *
 * The structured object is what machines want and what pino stores; this is
 * what someone staring at "why did it play that" needs, and it is attached as
 * the log message for exactly the two cases worth reading — a failed resolution
 * and a fall-through to YouTube.
 */
export function formatResolutionTrace(trace: ResolutionTrace): string {
  const lines = [
    '[MusicResolver]',
    `Track: ${trace.track}`,
    `Artist: ${trace.artist}`,
    `ISRC: ${trace.isrc ?? '(none)'}`,
    `Duration: ${String(Math.round(trace.durationMs / 1000))}s (via ${trace.metadataProvider})`,
  ];
  if (trace.requestedVariants.length > 0) {
    lines.push(`Requested version: ${trace.requestedVariants.join(', ')}`);
  }

  for (const attempt of trace.attempts) {
    const name = attempt.provider === 'soundcloud' ? 'SoundCloud' : 'YouTube';
    lines.push(
      '',
      `${name} candidates: ${String(attempt.considered)} (${String(attempt.queriesRun)} queries)`,
    );
    if (attempt.decision === 'provider-error') {
      lines.push(`  provider error: ${attempt.error ?? 'unknown'}`);
      continue;
    }
    for (const rejection of attempt.rejected) {
      lines.push(`  rejected: ${rejection.title} — ${rejection.reason}`);
    }
    if (attempt.best === null) {
      lines.push('  no acceptable match');
    } else {
      lines.push(
        `  best: ${attempt.best.author} — ${attempt.best.title}`,
        `  score: ${String(Math.round(attempt.best.score))} (${attempt.best.why})`,
      );
    }
    lines.push(`  decision: ${attempt.decision.toUpperCase()}`);
  }

  lines.push(
    '',
    trace.decision === 'play'
      ? `Decision: PLAY from ${trace.playedFrom ?? 'unknown'}`
      : 'Decision: NO RELIABLE MATCH',
  );
  return lines.join('\n');
}

/**
 * One log line per resolution.
 *
 * Level is chosen by how much anyone needs to see it. A track that resolved on
 * SoundCloud first try is the expected path and stays at debug, because a
 * thousand-track playlist must not narrate itself. Falling through to YouTube
 * or failing outright is the interesting case and goes to info with the
 * human-readable trace attached, since those are the two things somebody will
 * come looking for after a bad match.
 */
function logResolution(trace: ResolutionTrace): void {
  const fellThrough =
    trace.playedFrom !== null && trace.playedFrom !== (trace.attempts[0]?.provider ?? null);
  if (trace.decision === 'no-match' || fellThrough) {
    logger.info({ resolution: trace }, formatResolutionTrace(trace));
    return;
  }
  logger.debug({ resolution: trace }, 'Playback resolved');
}
