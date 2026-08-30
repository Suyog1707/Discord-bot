/**
 * Slot planning — the cadence of the radio.
 *
 * Autoplay generates in small batches (usually two tracks at a time), but the
 * experience it has to produce is a long one: a few songs you know, then
 * something new, then a few you know again. A per-batch rule cannot express
 * that — two tracks generated in isolation have no idea that the previous batch
 * already spent its discovery slot. So the cadence is carried in the SESSION,
 * not in the batch: the planner hands this module the kinds already played or
 * queued (newest first) and the run continues across batch boundaries.
 *
 * Deliberately pure and deliberately dumb: it decides only `'familiar'` or
 * `'discovery'` per slot, never which track fills it. Picking is the planner's
 * job, and keeping the two apart is what makes the cadence testable without a
 * database, a network, or a clock.
 *
 * No randomness anywhere. Same inputs, same plan — a radio that shuffles its own
 * structure is impossible to reason about when a listener says "it stopped
 * playing my music".
 */

/** Whether a slot should be filled from what the room knows, or from novelty. */
export type AutoplayKind = 'familiar' | 'discovery';

export interface InterleaveConfig {
  /** Familiar tracks between discoveries when the familiar pool is ordinary. */
  readonly familiarRunMin: number;
  /** Familiar tracks between discoveries when the familiar pool is strong. */
  readonly familiarRunMax: number;
  /** When false, discovery slots are never planned at all. */
  readonly discoveryEnabled: boolean;
}

/**
 * Spec defaults: two to three familiar, then one discovery.
 *
 * Two is the floor because one-in-two is not a radio the room recognises, and
 * three is the ceiling because a listener who has to wait four songs for
 * anything new stops hearing autoplay as exploration at all.
 */
export const DEFAULT_INTERLEAVE: InterleaveConfig = {
  familiarRunMin: 2,
  familiarRunMax: 3,
  discoveryEnabled: true,
};

/**
 * How many strong familiar candidates make a pool "strong" enough to stretch the
 * run to its maximum. Below this the pool would start repeating itself before
 * the next discovery, which is worse than discovering a little more often.
 */
const STRONG_FAMILIAR_POOL = 6;

export interface InterleaveInput {
  readonly count: number;
  /** Kinds of autoplay tracks already played/queued this session, NEWEST first. */
  readonly recentKinds: readonly AutoplayKind[];
  /** Familiar candidates available that clear the score floor. */
  readonly familiarAvailable: number;
  /** Discovery candidates available that clear the score floor. */
  readonly discoveryAvailable: number;
  /** Strength of familiar pool: number of familiar candidates with score >= strong threshold. */
  readonly familiarStrong: number;
  readonly config?: InterleaveConfig;
}

/**
 * Plan the kinds for the next `count` slots.
 *
 * Returns FEWER than `count` entries when both pools run dry — a short queue is
 * honest, filler is not. Availability is consumed as slots are assigned, so a
 * plan never promises more familiar tracks than the pool can actually supply.
 */
export function planSlots(input: InterleaveInput): readonly AutoplayKind[] {
  const config = input.config ?? DEFAULT_INTERLEAVE;
  const count = Math.max(0, Math.floor(input.count));

  let familiarLeft = countOf(input.familiarAvailable);
  let discoveryLeft = config.discoveryEnabled ? countOf(input.discoveryAvailable) : 0;

  const target = targetRun(config, {
    familiarAvailable: familiarLeft,
    discoveryAvailable: discoveryLeft,
    familiarStrong: countOf(input.familiarStrong),
  });

  // The run in progress: how many familiar tracks have played since the last
  // discovery. This is the whole reason cadence survives a batch boundary.
  let run = leadingFamiliar(input.recentKinds);

  const slots: AutoplayKind[] = [];

  for (let slot = 0; slot < count; slot += 1) {
    // Two discoveries back to back is the one shape this module must never
    // produce while the room's own music is still on the table.
    const repeatsDiscovery = slots.at(-1) === 'discovery' && familiarLeft > 0;

    if (run >= target && discoveryLeft > 0 && !repeatsDiscovery) {
      slots.push('discovery');
      discoveryLeft -= 1;
      run = 0;
      continue;
    }

    if (familiarLeft > 0) {
      slots.push('familiar');
      familiarLeft -= 1;
      run += 1;
      continue;
    }

    if (discoveryLeft > 0) {
      slots.push('discovery');
      discoveryLeft -= 1;
      run = 0;
      continue;
    }

    break; // both pools exhausted — return what can actually be filled
  }

  return slots;
}

/**
 * How many familiar tracks may run before a discovery is due.
 *
 * `Infinity` is a real answer here, not a guard: with discovery unavailable or
 * switched off, the correct plan is all familiar, forever, rather than empty
 * slots waiting for a pool that is not coming.
 */
function targetRun(
  config: InterleaveConfig,
  pool: {
    readonly familiarAvailable: number;
    readonly discoveryAvailable: number;
    readonly familiarStrong: number;
  },
): number {
  if (pool.discoveryAvailable === 0) return Number.POSITIVE_INFINITY;
  // Nothing familiar to run: discovery is not a break from the room's music,
  // it IS the music this cycle.
  if (pool.familiarAvailable === 0) return 0;

  const min = Math.max(1, Math.floor(config.familiarRunMin));
  const max = Math.max(min, Math.floor(config.familiarRunMax));
  return pool.familiarStrong >= STRONG_FAMILIAR_POOL ? max : min;
}

/**
 * Familiar tracks since the last discovery, read off the newest-first history.
 *
 * Counting stops at the first discovery: everything before it belongs to a run
 * that has already been paid for.
 */
function leadingFamiliar(recentKinds: readonly AutoplayKind[]): number {
  let run = 0;
  for (const kind of recentKinds) {
    if (kind !== 'familiar') break;
    run += 1;
  }
  return run;
}

/** Non-negative whole count, tolerant of junk from callers and env parsing. */
function countOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
