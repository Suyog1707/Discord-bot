/**
 * Audio filter presets, expressed as Lavalink `FilterOptions`.
 *
 * Every preset here maps directly onto filters Lavalink v4 implements
 * natively (equalizer, timescale, karaoke, tremolo, vibrato, rotation,
 * distortion, channelMix, lowPass). Effects the engine cannot produce —
 * true echo/reverb need an impulse-response DSP stage Lavalink does not
 * ship — are intentionally absent rather than faked badly.
 *
 * Presets replace each other (applying one clears the previous), which keeps
 * the mental model simple: one named sound at a time, `off` returns to clean
 * playback. Speed and pitch are parameterised separately in `/filter speed`
 * and `/filter pitch` since they take a value rather than a fixed shape.
 */
import type { Band, FilterOptions } from 'shoukaku';

/** Equalizer helper: bands 0–14 (25 Hz – 16 kHz), gain -0.25..1.0. */
function eq(...bands: readonly (readonly [number, number])[]): Band[] {
  return bands.map(([band, gain]) => ({ band, gain }));
}

export const FILTER_PRESETS = {
  bassboost: {
    equalizer: eq([0, 0.18], [1, 0.16], [2, 0.12], [3, 0.08], [4, 0.04]),
  },
  trebleboost: {
    equalizer: eq([10, 0.12], [11, 0.14], [12, 0.16], [13, 0.18]),
  },
  nightcore: {
    timescale: { speed: 1.15, pitch: 1.2, rate: 1.0 },
  },
  vaporwave: {
    timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 },
    equalizer: eq([0, 0.15], [1, 0.1]),
  },
  karaoke: {
    karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 },
  },
  eightd: {
    rotation: { rotationHz: 0.2 },
  },
  tremolo: {
    tremolo: { frequency: 4.0, depth: 0.5 },
  },
  vibrato: {
    vibrato: { frequency: 4.0, depth: 0.5 },
  },
  softdistortion: {
    distortion: { sinOffset: 0, sinScale: 0.4, cosOffset: 0, cosScale: 0.4, offset: 0, scale: 0.8 },
  },
  mono: {
    channelMix: { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 },
  },
  lowpass: {
    lowPass: { smoothing: 15.0 },
  },
} as const satisfies Record<string, FilterOptions>;

export type FilterPresetName = keyof typeof FILTER_PRESETS;

export const FILTER_PRESET_NAMES = Object.keys(FILTER_PRESETS) as readonly FilterPresetName[];

/** Human labels for command choices and status displays. */
export const FILTER_LABELS: Record<FilterPresetName, string> = {
  bassboost: 'Bass Boost',
  trebleboost: 'Treble Boost',
  nightcore: 'Nightcore',
  vaporwave: 'Vaporwave',
  karaoke: 'Karaoke',
  eightd: '8D (rotating audio)',
  tremolo: 'Tremolo',
  vibrato: 'Vibrato',
  softdistortion: 'Soft Distortion',
  mono: 'Mono',
  lowpass: 'Low Pass',
};

/** Bounds for the parameterised timescale filters. */
export const TIMESCALE_LIMITS = {
  SPEED_MIN: 0.5,
  SPEED_MAX: 2.0,
  PITCH_MIN: 0.5,
  PITCH_MAX: 2.0,
} as const;

export function speedFilter(speed: number): FilterOptions {
  return { timescale: { speed, pitch: 1.0, rate: 1.0 } };
}

export function pitchFilter(pitch: number): FilterOptions {
  return { timescale: { speed: 1.0, pitch, rate: 1.0 } };
}
