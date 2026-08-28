/**
 * Environment → resolver configuration.
 *
 * `match-config.ts` holds the numbers and knows nothing about `process.env`;
 * this is the one place that reads configuration and turns it into the options
 * the resolver takes. Keeping those apart is what lets the matcher be tested
 * with explicit weights rather than by mutating the environment.
 *
 * Memoised, because it is consulted once per track on a playlist expansion and
 * the answer cannot change without a restart.
 */
import { getEnv } from '../config/env.js';
import type { PlaybackProvider } from './candidate-matcher.js';
import { applyOverrides, type DurationRules, type MatchWeights } from './match-config.js';

export interface ResolutionSettings {
  readonly order: readonly PlaybackProvider[];
  readonly duration: DurationRules;
  readonly weights: Record<PlaybackProvider, MatchWeights>;
  /** Operator-supplied rights-holder tokens, merged with the built-in generic ones. */
  readonly officialChannelTokens: readonly string[];
}

let cached: ResolutionSettings | undefined;

export function getResolutionSettings(): ResolutionSettings {
  if (cached !== undefined) return cached;

  const env = getEnv();
  const { duration, soundcloud, youtube } = applyOverrides({
    durationToleranceMs: env.MATCH_DURATION_TOLERANCE_MS,
    soundcloudAcceptScore: env.MATCH_SOUNDCLOUD_MIN_SCORE,
    youtubeAcceptScore: env.MATCH_YOUTUBE_MIN_SCORE,
  });

  cached = {
    order: env.PLAYBACK_PROVIDER_ORDER.split(',') as readonly PlaybackProvider[],
    duration,
    weights: { soundcloud, youtube },
    officialChannelTokens: (env.MATCH_OFFICIAL_CHANNELS ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  };
  return cached;
}

/** Test seam. */
export function resetResolutionSettings(): void {
  cached = undefined;
}
