/**
 * The primary's memory of what Discord actually sent.
 *
 * The gateway router hands a command to another bot as the raw API payload,
 * exactly as the HTTP router does, because that is what the subscriber
 * rehydrates. discord.js does not keep the payload once it has built the
 * interaction, so the primary captures it off the `raw` event a moment
 * earlier.
 *
 * Why the timing works: `WebSocketManager` emits `raw` synchronously, before
 * it hands the packet to the action that builds the interaction and emits
 * `interactionCreate`. So by the time a listener sees the interaction, its
 * payload is already here.
 *
 * Three things keep this from becoming a leak. Only the kinds the router
 * forwards are kept (commands and components, not autocomplete, which is
 * answered locally). An entry is read once and removed. And anything nobody
 * reads — a player's interaction that was never routed, an interaction the
 * event handler skipped — expires and is pruned as new ones arrive, with a
 * hard cap behind that.
 */
import { INTERACTION_TYPE, type RawInteraction } from '@discord-music/shared';

/** Longer than any handler could plausibly take to reach `take`. */
export const RAW_INTERACTION_TTL_MS = 30_000;

const DEFAULT_MAX_ENTRIES = 500;

export interface RawInteractionCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly payload: RawInteraction;
  readonly expiresAt: number;
}

export class RawInteractionCache {
  // A Map iterates in insertion order, so the front is always the oldest and
  // pruning never needs to scan the whole thing.
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: RawInteractionCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? RAW_INTERACTION_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Offered every gateway packet; keeps only command and component interactions. */
  capture(packet: unknown): void {
    if (typeof packet !== 'object' || packet === null) return;
    const { t, d } = packet as { readonly t?: unknown; readonly d?: unknown };
    if (t !== 'INTERACTION_CREATE' || typeof d !== 'object' || d === null) return;

    const { id, type } = d as { readonly id?: unknown; readonly type?: unknown };
    if (typeof id !== 'string') return;
    if (type !== INTERACTION_TYPE.command && type !== INTERACTION_TYPE.component) return;

    const now = this.#now();
    this.#prune(now);

    this.#entries.set(id, { payload: d as RawInteraction, expiresAt: now + this.#ttlMs });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** The payload for an interaction, once. */
  take(interactionId: string): RawInteraction | undefined {
    const entry = this.#entries.get(interactionId);
    if (entry === undefined) return undefined;
    this.#entries.delete(interactionId);
    return entry.expiresAt > this.#now() ? entry.payload : undefined;
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt > now) break;
      this.#entries.delete(id);
    }
  }
}
