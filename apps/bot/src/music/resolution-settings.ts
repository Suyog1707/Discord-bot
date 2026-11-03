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
  /** Providers the resolver walks, in order; never contains SoundCloud while it is disabled. */
  readonly order: readonly PlaybackProvider[];
  /** Whether SoundCloud search is allowed at all (`SOUNDCLOUD_ENABLED`). */
  readonly soundcloudEnabled: boolean;
  readonly duration: DurationRules;
  readonly weights: Record<PlaybackProvider, MatchWeights>;
  /** Operator-supplied rights-holder tokens, merged with the built-in generic ones. */
  readonly officialChannelTokens: readonly string[];
}

let cached: ResolutionSettings | undefined;

/**
 * The configured provider order with SoundCloud removed unless it is enabled.
 *
 * Every `scsearch:` lookup failed in production ("Did not detect any supported
 * formats"), so a disabled SoundCloud must disappear from the walk entirely —
 * not merely rank last — or each track would still wait on a doomed search.
 * If SoundCloud was the only configured provider, YouTube is what is left: an
 * empty order would turn every track into a miss. Pure; callers log nothing.
 */
export function enabledProviderOrder(
  configured: readonly PlaybackProvider[],
  soundcloudEnabled: boolean,
): readonly PlaybackProvider[] {
  if (soundcloudEnabled) return configured;
  const remaining = configured.filter((provider) => provider !== 'soundcloud');
  return remaining.length > 0 ? remaining : ['youtube'];
}

/**
 * The providers a request may search, given the user's source choice.
 *
 * `auto` follows the configured order. An explicit choice pins the walk to
 * that one provider and never falls through to another the user did not ask
 * for. An explicit SoundCloud pin while SoundCloud is off yields an empty list,
 * meaning "nothing to search": callers must short-circuit rather than fall
 * back to YouTube.
 */
export function providerOrderFor(
  preference: 'auto' | PlaybackProvider,
  settings: Pick<ResolutionSettings, 'order' | 'soundcloudEnabled'>,
): readonly PlaybackProvider[] {
  if (preference === 'auto') return settings.order;
  if (preference === 'youtube') return ['youtube'];
  return settings.soundcloudEnabled ? ['soundcloud'] : [];
}

export function getResolutionSettings(): ResolutionSettings {
  if (cached !== undefined) return cached;

  const env = getEnv();
  const { duration, soundcloud, youtube } = applyOverrides({
    durationToleranceMs: env.MATCH_DURATION_TOLERANCE_MS,
    soundcloudAcceptScore: env.MATCH_SOUNDCLOUD_MIN_SCORE,
    youtubeAcceptScore: env.MATCH_YOUTUBE_MIN_SCORE,
  });

  cached = {
    order: enabledProviderOrder(
      env.PLAYBACK_PROVIDER_ORDER.split(',') as readonly PlaybackProvider[],
      env.SOUNDCLOUD_ENABLED,
    ),
    soundcloudEnabled: env.SOUNDCLOUD_ENABLED,
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
