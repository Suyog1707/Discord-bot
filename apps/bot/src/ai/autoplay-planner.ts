/**
 * The autoplay planner — where "play what I like, occasionally surprise me"
 * is actually decided.
 *
 * The recommender underneath this is a similarity engine: hand it a seed and
 * it returns the neighbourhood. Left to run autoplay on its own, that is what
 * a listener gets — a neighbourhood — and a neighbourhood is not a person's
 * taste. A person's taste is mostly songs they already know: the ones they
 * asked for, saved, put in a playlist, or kept finishing. So this module keeps
 * two pools apart and never lets the scoring of one leak into the other:
 *
 *   KNOWN     — requested / playlist / library / history, scored by how much
 *               THIS listener has demonstrated they like each song
 *   DISCOVERY — the similarity engine's output, minus everything in KNOWN, so
 *               a discovery is by construction something the listener has not
 *               played, saved or listed
 *
 * A slot plan decides the rhythm — a few known songs, then exactly one
 * discovery, then back — and the plan is read off the session itself so the
 * rhythm carries across the two-track batches autoplay generates in. The pick
 * for each slot then comes from that slot's pool and nowhere else.
 *
 * Everything here works on canonical (artist, title, duration) identities. The
 * planner never names a provider: a chosen song is handed to the resolvers the
 * music layer injected, and SoundCloud-versus-YouTube is decided there.
 */
import { getLogger } from '../lib/logger.js';
import type { QueuedTrack } from '../music/track.js';

import {
  neighbourhoodScore,
  type CooccurrenceService,
  type CooccurrenceSignals,
} from './cooccurrence.js';
import {
  explainFamiliar,
  scoreFamiliar,
  type FamiliarCandidate,
  type FamiliarScoringContext,
  type ScoredFamiliar,
} from './familiar-scoring.js';
import type { FamiliarPoolService } from './familiar.js';
import { identityOf } from './identity.js';
import {
  DEFAULT_INTERLEAVE,
  planSlots,
  type AutoplayKind,
  type InterleaveConfig,
} from './interleave.js';
import { languageFromText } from './language.js';
import { TrackProfileResolver, type TrackProfile } from './track-profile.js';
import { MusicOrchestrator } from './orchestrator.js';
import type { RecommendationExclusions, RecommendationService, TrackSeed } from './recommender.js';
import type { ScoredCandidate } from './scoring.js';
import type { AutoplaySessionStore, SessionSnapshot } from './session.js';
import {
  blendProfiles,
  type RecentContext,
  type TasteProfile,
  type UserTasteService,
} from './taste.js';

const logger = getLogger('autoplay-planner');

/** One generated pick, with the key its reservation is held under. */
export interface GeneratedTrack {
  readonly track: QueuedTrack;
  readonly reservedKey: string;
}

/**
 * What the autoplay engine needs from whatever chooses its songs.
 *
 * The engine owns buffering, gating and TTLs; it should not care whether the
 * songs come from this planner, the bare recommender, or a test double.
 */
export interface AutoplayGenerator {
  generate(
    guildId: string,
    seeds: readonly TrackSeed[],
    count: number,
    options: { readonly background: boolean },
  ): Promise<readonly GeneratedTrack[]>;
}

/**
 * The two ways a chosen song becomes audio. Injected by the music layer,
 * which is the only place allowed to know about playback providers.
 *
 * Two functions rather than one because the inputs genuinely differ: a known
 * song carries a runtime and usually a catalogue URL, which make the match
 * far more certain than a bare artist–title pair ever can be.
 */
export interface PlannerResolvers {
  readonly resolveKnown: (candidate: FamiliarCandidate) => Promise<QueuedTrack | null>;
  readonly resolveDiscovery: (candidate: {
    readonly title: string;
    readonly artist: string;
  }) => Promise<QueuedTrack | null>;
}

export interface PlannerConfig {
  readonly interleave: InterleaveConfig;
  /** Known songs scoring below this are not played merely to fill a slot. */
  readonly familiarMinScore: number;
  /** At or above this a known song counts toward "the pool is strong". */
  readonly familiarStrongScore: number;
  /** Discoveries scoring below this are not introduced at all. */
  readonly discoveryMinScore: number;
  /** How many listeners' personal profiles blend into the room's taste. */
  readonly maxListeners: number;
  /** Extra candidates tried for a slot whose pick failed to resolve. */
  readonly resolveRetries: number;
  /** Known candidates whose artists get tags fetched before the final ranking. */
  readonly familiarTagShortlist: number;
  /**
   * Intelligent repetition: a song played within this window, or within
   * this many recent plays, is excluded from BOTH pools. Beyond it the song
   * is eligible again and the familiar scorer's rest curve decides how
   * eager autoplay should be to bring it back.
   */
  readonly repeatCooldownMs: number;
  readonly repeatCooldownPlays: number;
  /**
   * Lower bound for the relaxed cooldown (`max(floor, repeatCooldownMs / 2)`).
   * A single relaxation step: at the default 3 h cooldown the relaxed window
   * is 90 min and this floor only bites when an operator configures a
   * cooldown of an hour or less.
   */
  readonly relaxedCooldownFloorMs: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  interleave: DEFAULT_INTERLEAVE,
  familiarMinScore: 0.35,
  familiarStrongScore: 0.6,
  discoveryMinScore: 0.3,
  maxListeners: 3,
  resolveRetries: 2,
  familiarTagShortlist: 40,
  repeatCooldownMs: 3 * 60 * 60_000,
  repeatCooldownPlays: 12,
  relaxedCooldownFloorMs: 30 * 60_000,
};

/** Penalty per disliked song by the same artist, capped at two. A dislike is about a song, not a discography. */
const DISLIKED_ARTIST_PENALTY = 0.1;
const DISLIKED_ARTIST_PENALTY_CAP = 2;

/**
 * Hard ceiling on candidates one slot may touch, independent of the retry
 * budget. A lost reservation does not spend a retry (it is not the
 * candidate's fault), so without this a contended guild could walk the whole
 * pool one Redis round trip at a time while a listener waits.
 */
const MAX_SLOT_ITERATIONS = 12;

/** Guild profile weight relative to a listener's own profile in the blend. */
const GUILD_PROFILE_WEIGHT = 0.6;
const LISTENER_PROFILE_WEIGHT = 1;

/**
 * What the planner needs from the dislike store. An interface rather than the
 * service class so the AI layer depends on a shape, not on Prisma.
 */
export interface DislikeSource {
  /**
   * Everything the planner needs in one read: the canonical keys disliked by
   * any of these Discord users, and per artist how many of their songs were.
   */
  dislikesFor(discordIds: readonly string[]): Promise<{
    readonly keys: ReadonlySet<string>;
    readonly artistCounts: ReadonlyMap<string, number>;
  }>;
}

interface PlannerServices {
  readonly session: AutoplaySessionStore;
  readonly taste: UserTasteService;
  readonly familiar: FamiliarPoolService;
  readonly recommender: RecommendationService;
  readonly dislikes?: DislikeSource;
  /** Behavioural similarity — what the room plays, saves and lists together. */
  readonly cooccurrence?: CooccurrenceService;
  /**
   * Metadata enrichment: normalised genres, families and a confidence-aware
   * language for each known candidate on the shortlist. Optional so the
   * planner runs on raw tags when no resolver is wired.
   */
  readonly profiles?: TrackProfileResolver;
  readonly config?: Partial<PlannerConfig>;
}

/**
 * How much "the room plays these together" moves a score. Known songs get the
 * larger share: behaviour is the strongest evidence there is about what fits
 * next when no audio features exist. A discovery only gets an artist-level
 * nudge — by definition the room has no behaviour on the song itself.
 */
const BEHAVIOUR_FAMILIAR_WEIGHT = 0.12;
const BEHAVIOUR_DISCOVERY_WEIGHT = 0.05;

const EMPTY_SIGNALS: CooccurrenceSignals = { tracks: new Map(), artists: new Map() };

/** One cooldown regime for a pool-building pass. */
interface Cooldown {
  readonly ms: number;
  readonly plays: number;
  readonly relaxed: boolean;
}

/** Everything a pool-building pass produces. */
interface Pools {
  readonly exclusions: RecommendationExclusions;
  readonly familiarRanked: readonly ScoredFamiliar[];
  readonly familiarStrong: number;
  readonly discoveryRanked: readonly ScoredCandidate[];
  readonly cooldown: Cooldown;
  readonly cooledDown: number;
  /** Known candidates the cooldown alone removed — what relaxing would give back. */
  readonly cooledOut: number;
}

/** A candidate of either kind, normalised for the slot walk. */
interface SlotCandidate {
  readonly kind: AutoplayKind;
  readonly key: string;
  readonly artistKey: string;
  readonly score: number;
  readonly familiar?: FamiliarCandidate;
  readonly discovery?: { readonly title: string; readonly artist: string };
  readonly label: string;
  /** The single strongest signal behind the score, for the selection log. */
  readonly reason: string;
}

export class AutoplayPlanner implements AutoplayGenerator {
  readonly #services: PlannerServices;
  readonly #config: PlannerConfig;
  #resolvers: PlannerResolvers | undefined;

  constructor(services: PlannerServices) {
    this.#services = services;
    this.#config = { ...DEFAULT_PLANNER_CONFIG, ...services.config };
  }

  /** Wired once by the music layer; the planner is inert until then. */
  setResolvers(resolvers: PlannerResolvers): void {
    this.#resolvers = resolvers;
  }

  get config(): PlannerConfig {
    return this.#config;
  }

  async generate(
    guildId: string,
    seeds: readonly TrackSeed[],
    count: number,
    options: { readonly background: boolean },
  ): Promise<readonly GeneratedTrack[]> {
    const resolvers = this.#resolvers;
    if (resolvers === undefined) {
      throw new Error('AutoplayPlanner has no resolvers; the music layer has not attached.');
    }
    if (count <= 0) return [];
    const startedAt = Date.now();

    const snapshot = await this.#services.session.snapshot(guildId);
    const listenerIds = snapshot.listenerIds.slice(0, this.#config.maxListeners);

    // Taste, recency, the known pool and the dislike ledger are independent reads.
    const [profile, recent, pool, dislikes, behaviour] = await Promise.all([
      this.#blendedProfile(guildId, listenerIds, options),
      this.#services.taste.recentContext(guildId),
      this.#services.familiar.pool(guildId, listenerIds),
      this.#dislikes(listenerIds, snapshot),
      this.#services.cooccurrence?.signals(guildId, listenerIds).catch(() => EMPTY_SIGNALS) ??
        Promise.resolve(EMPTY_SIGNALS),
    ]);
    const disliked = dislikes.keys;
    const dislikedArtists = dislikes.artistCounts;

    const seedArtists = seeds.map((seed) => identityOf(seed.artist, seed.title).artistKey);
    const sessionLanguage = seedLanguageOf(seeds);
    const now = Date.now();
    const scoringContext: FamiliarScoringContext = {
      profile,
      recent,
      artistFatigue: snapshot.artistFatigue,
      seedArtists,
      sessionLanguage,
      now,
    };
    const passInput = {
      seeds,
      count,
      snapshot,
      profile,
      recent,
      pool,
      disliked,
      dislikedArtists,
      behaviour,
      seedKeys: seeds.map((seed) => identityOf(seed.artist, seed.title).key),
      seedArtists,
      scoringContext,
      options,
      now,
    };

    // Normal cooldown first. If it leaves NOTHING to play — a small library
    // deep into a long session — the same pass runs again with the cooldown
    // relaxed, so the radio brings back songs from a few hours ago rather
    // than falling silent. Hard exclusions (playing, queued, reserved,
    // disliked, the seeds) never relax.
    let pools = await this.#buildPools(passInput, {
      ms: this.#config.repeatCooldownMs,
      plays: this.#config.repeatCooldownPlays,
      relaxed: false,
    });
    // Relaxation is judged on the KNOWN pool alone. A renewing discovery
    // neighbourhood must not keep the listener's own library locked behind
    // the cooldown — that is exactly how a 30-song library turns into six
    // discoveries in a row forty minutes into a session. Nothing to relax
    // when there is no library at all (cold start): that is discovery-only
    // by nature, not by cooldown.
    // …and only when the cooldown is what emptied it. A pool whose songs
    // simply score below the floor gains nothing from a second pass and
    // would pay for one on every generation.
    const knownStarved = pools.familiarRanked.length === 0 && pools.cooledOut > 0;
    if (knownStarved || (pools.familiarRanked.length === 0 && pools.discoveryRanked.length === 0)) {
      const relaxed: Cooldown = {
        ms: Math.max(this.#config.relaxedCooldownFloorMs, this.#config.repeatCooldownMs / 2),
        plays: Math.max(3, Math.floor(this.#config.repeatCooldownPlays / 2)),
        relaxed: true,
      };
      logger.info(
        {
          event: 'AUTOPLAY_RELAXED',
          guildId,
          cooldownMs: relaxed.ms,
          cooldownPlays: relaxed.plays,
        },
        'No eligible candidates under the normal cooldown; relaxing repetition rules',
      );
      pools = await this.#buildPools(passInput, relaxed);
    }
    const { exclusions, familiarRanked, familiarStrong, discoveryRanked } = pools;

    logger.info(
      {
        event: 'CANDIDATE_GENERATION',
        guildId,
        familiarPool: pool.length,
        familiarEligible: familiarRanked.length,
        familiarStrong,
        discoveryEligible: discoveryRanked.length,
        disliked: disliked.size,
        cooledDown: pools.cooledDown,
        relaxed: pools.cooldown.relaxed,
        listeners: listenerIds.length,
      },
      'Candidate pools built',
    );

    /* --- Plan the rhythm ------------------------------------------------- */

    const kinds = planSlots({
      count,
      recentKinds: snapshot.recentAutoplayKinds,
      familiarAvailable: familiarRanked.length,
      discoveryAvailable: discoveryRanked.length,
      familiarStrong,
      config: this.#config.interleave,
    });

    const familiarQueue: SlotCandidate[] = familiarRanked.map((entry) => ({
      kind: 'familiar',
      key: entry.trackKey,
      artistKey: entry.artistKey,
      score: entry.score,
      familiar: entry.candidate,
      label: `${entry.candidate.artist} — ${entry.candidate.title}`,
      reason: primaryReason(entry.breakdown, [
        'source',
        'replay',
        'completion',
        'requested',
        'artistAffinity',
        'context',
        'recencyRest',
        'behaviour',
      ]),
    }));
    const discoveryQueue: SlotCandidate[] = discoveryRanked.map((entry) => ({
      kind: 'discovery',
      key: entry.trackKey,
      artistKey: entry.artistKey,
      score: entry.breakdown.final,
      discovery: { title: entry.candidate.title, artist: entry.candidate.artist },
      label: `${entry.candidate.artist} — ${entry.candidate.title}`,
      reason: primaryReason(entry.breakdown, [
        'similarity',
        'tagAffinity',
        'userAffinity',
        'moodFit',
        'novelty',
        'recentBehaviour',
      ]),
    }));

    /* --- Fill the slots -------------------------------------------------- */

    const cycle = new CycleState(exclusions);
    const results: GeneratedTrack[] = [];
    let blocked = 0;

    // Slots are filled in order, each one to completion (pick → reserve →
    // resolve → retry on failure) before the next: the plan's rhythm is only
    // meaningful if slot N is settled before slot N+1 chooses.
    try {
      for (const kind of kinds) {
        const primary = kind === 'familiar' ? familiarQueue : discoveryQueue;
        const secondary = kind === 'familiar' ? discoveryQueue : familiarQueue;

        let filled = await this.#fillSlot(guildId, primary, cycle, resolvers);
        blocked += filled.blocked;
        // The plan asked for a kind the pool could not deliver (every candidate
        // failed to resolve, or lost its reservation). The other pool is a
        // better outcome than a hole — but only one swap, so a dead discovery
        // pool cannot turn the whole batch into discoveries.
        if (filled.entry === null && secondary.length > 0) {
          filled = await this.#fillSlot(guildId, secondary, cycle, resolvers);
          blocked += filled.blocked;
        }
        if (filled.entry !== null) results.push(filled.entry);
      }
    } catch (error) {
      // Picks already committed hold reservations nobody will ever play.
      // Hand them back before the failure propagates, or each stays locked
      // out for the full reservation TTL.
      await this.#services.session
        .release(
          guildId,
          results.map((entry) => entry.reservedKey),
        )
        .catch(() => undefined);
      throw error;
    }

    if (blocked > 0) {
      void this.#services.session
        .recordOutcome(guildId, 'duplicatesBlocked', blocked)
        .catch(() => undefined);
    }

    logger.info(
      {
        event: 'AUTOPLAY_PLAN',
        guildId,
        requested: count,
        plan: kinds,
        served: results.map((entry) => ({
          kind: entry.track.autoplayKind,
          track: `${entry.track.author} — ${entry.track.title}`,
        })),
        relaxed: pools.cooldown.relaxed,
        blocked,
        durationMs: Date.now() - startedAt,
      },
      'Autoplay plan',
    );
    // The arithmetic behind the top of the known pool, for "why did it play
    // that again?" — trace level, one line per candidate.
    if (logger.isLevelEnabled('trace')) {
      for (const entry of familiarRanked.slice(0, 5)) {
        logger.trace(
          { guildId, track: `${entry.candidate.artist} — ${entry.candidate.title}` },
          explainFamiliar(entry),
        );
      }
    }

    return results;
  }

  /**
   * Re-score a shortlist with artist tags attached.
   *
   * Per artist, capped by the shortlist size, and cache-fronted for a week by
   * the recommender — for a pool whose artists are mostly the listener's
   * favourites, every one of these is already warm. Any failure leaves the
   * candidate scored without tags, exactly as pass one had it.
   */
  async #enrichFamiliar(
    shortlist: readonly ScoredFamiliar[],
    context: FamiliarScoringContext,
  ): Promise<readonly ScoredFamiliar[]> {
    if (shortlist.length === 0) return shortlist;

    // With a profile resolver the shortlist gets the full TrackProfile:
    // raw tags plus normalised genres and families (so "Bollywood" and
    // "Hindi Film Songs" land on one affinity key) and a language with a
    // confidence the scorer respects. Enrichment is fetched ONCE PER ARTIST
    // — forty shortlist entries by six artists cost six lookups, not forty —
    // and each song's own profile is then derived without I/O.
    const profiles = this.#services.profiles;
    if (profiles !== undefined) {
      const byArtist = new Map<string, Promise<TrackProfile | null>>();
      const enrichmentFor = (candidate: FamiliarCandidate): Promise<TrackProfile | null> => {
        const artistKey = identityOf(candidate.artist, candidate.title).artistKey;
        let pending = byArtist.get(artistKey);
        if (pending === undefined) {
          pending = profiles
            .resolve({
              title: candidate.title,
              artist: candidate.artist,
              durationMs: candidate.durationMs,
              provider: candidate.source,
            })
            .catch(() => null);
          byArtist.set(artistKey, pending);
        }
        return pending;
      };
      return Promise.all(
        shortlist.map(async (entry) => {
          const candidate = entry.candidate;
          const enriched = await enrichmentFor(candidate);
          if (enriched === null) return entry;
          // The artist's tags apply to every song; the language is resolved
          // per song, because the title's script is the song's own.
          const own = TrackProfileResolver.fromMetadata({
            title: candidate.title,
            artist: candidate.artist,
            durationMs: candidate.durationMs,
            provider: candidate.source,
            tags: enriched.rawTags,
          });
          const tags = [...new Set([...own.rawTags, ...own.genres, ...own.families])];
          return scoreFamiliar(
            {
              ...candidate,
              ...(tags.length === 0 ? {} : { tags }),
              language: { value: own.language.value, confidence: own.language.confidence },
            },
            context,
          );
        }),
      );
    }

    const artists = [...new Set(shortlist.map((entry) => entry.candidate.artist))];
    const tagsByArtist = new Map<string, readonly string[]>();
    await Promise.all(
      artists.map(async (artist) => {
        const tags = await this.#services.recommender.artistTags(artist).catch(() => []);
        if (tags.length > 0) tagsByArtist.set(artist, tags);
      }),
    );
    return shortlist.map((entry) => {
      const tags = tagsByArtist.get(entry.candidate.artist);
      if (tags === undefined) return entry;
      return scoreFamiliar({ ...entry.candidate, tags }, context);
    });
  }

  /**
   * Fill one slot from one pool: the best remaining candidate that wins its
   * reservation and resolves to something playable that is not a duplicate.
   *
   * Failures cost the candidate, never the slot: a song that no provider can
   * play is released and the next-best is tried, up to the retry budget.
   */
  async #fillSlot(
    guildId: string,
    queue: SlotCandidate[],
    cycle: CycleState,
    resolvers: PlannerResolvers,
  ): Promise<{ readonly entry: GeneratedTrack | null; readonly blocked: number }> {
    let attempts = 0;
    let iterations = 0;
    let blocked = 0;
    while (
      queue.length > 0 &&
      attempts <= this.#config.resolveRetries &&
      iterations < MAX_SLOT_ITERATIONS
    ) {
      iterations += 1;
      const candidate = cycle.takeBest(queue);
      if (candidate === null) break;
      attempts += 1;

      const granted = await this.#services.session.reserve(guildId, [candidate.key]);
      if (!granted.has(candidate.key)) {
        // Another generation pass claimed it first. Not a failure of this
        // candidate, so it does not spend a retry.
        attempts -= 1;
        continue;
      }

      const track = await this.#resolve(candidate, resolvers);
      if (track === null) {
        await this.#services.session.release(guildId, [candidate.key]).catch(() => undefined);
        logger.debug(
          { guildId, track: candidate.label, kind: candidate.kind },
          'Autoplay pick failed to resolve',
        );
        continue;
      }

      // The resolved upload speaks its own vocabulary; check it again.
      const resolvedKey = identityOf(track.author, track.title).key;
      if (cycle.isDuplicate(track.identifier, resolvedKey)) {
        blocked += 1;
        await this.#services.session.release(guildId, [candidate.key]).catch(() => undefined);
        logger.debug(
          { event: 'CANDIDATE_EXCLUDED', guildId, track: candidate.label },
          'Post-resolution duplicate blocked',
        );
        continue;
      }
      cycle.commit(candidate, track.identifier, resolvedKey);
      logger.info(
        {
          event: 'AUTOPLAY_SELECTION',
          guildId,
          slot: candidate.kind,
          track: candidate.label,
          score: Number(candidate.score.toFixed(3)),
          reason: candidate.reason,
          attempts,
        },
        'Autoplay slot filled',
      );

      return {
        entry: {
          track: {
            ...track,
            origin: 'autoplay',
            autoplayKind: candidate.kind,
            sourceKey: candidate.key,
          },
          reservedKey: candidate.key,
        },
        blocked,
      };
    }
    return { entry: null, blocked };
  }

  async #resolve(
    candidate: SlotCandidate,
    resolvers: PlannerResolvers,
  ): Promise<QueuedTrack | null> {
    try {
      if (candidate.familiar !== undefined) return await resolvers.resolveKnown(candidate.familiar);
      if (candidate.discovery !== undefined)
        return await resolvers.resolveDiscovery(candidate.discovery);
      return null;
    } catch (error) {
      logger.debug({ err: error, track: candidate.label }, 'Autoplay resolution threw');
      return null;
    }
  }

  /**
   * The room's taste: each present listener's own profile, plus the guild's
   * as a weaker prior. A voice channel is people, not a database row, and the
   * people who put songs on are who autoplay should sound like.
   */
  async #blendedProfile(
    guildId: string,
    listenerIds: readonly string[],
    options: { readonly background: boolean },
  ): Promise<TasteProfile> {
    // Listener profiles are only recomputed in the background: on the
    // synchronous path a listener is waiting in silence, and a day-old
    // personal profile beats a fresh one that arrives after the gap.
    const [guild, ...listeners] = await Promise.all([
      this.#services.taste.profile({ guildId }),
      ...listenerIds.map((userId) =>
        this.#services.taste.profile({ userId }, { allowRefresh: options.background }),
      ),
    ]);
    return blendProfiles([
      { profile: guild, weight: GUILD_PROFILE_WEIGHT },
      ...listeners.map((profile) => ({ profile, weight: LISTENER_PROFILE_WEIGHT })),
    ]);
  }

  /**
   * Build both pools under one cooldown regime.
   *
   * The exclusion set is two-tiered. HARD: what is playing, queued, reserved
   * by another pass, explicitly disliked, or the seeds themselves — never
   * played, whatever the pool looks like. COOLDOWN: recent plays inside the
   * time window or inside the last N plays — a rule about repetition, not
   * about the song, which is why it is allowed to relax.
   */
  async #buildPools(
    input: {
      readonly seeds: readonly TrackSeed[];
      readonly count: number;
      readonly snapshot: SessionSnapshot;
      readonly profile: TasteProfile;
      readonly recent: RecentContext;
      readonly pool: readonly FamiliarCandidate[];
      readonly disliked: ReadonlySet<string>;
      readonly dislikedArtists: ReadonlyMap<string, number>;
      readonly behaviour: CooccurrenceSignals;
      readonly seedKeys: readonly string[];
      readonly seedArtists: readonly string[];
      readonly scoringContext: FamiliarScoringContext;
      readonly options: { readonly background: boolean };
      readonly now: number;
    },
    cooldown: Cooldown,
  ): Promise<Pools> {
    const { snapshot, seeds } = input;

    const cooledKeys = new Set<string>();
    const cooledIdentifiers = new Set<string>();
    snapshot.recentEntries.forEach((entry, index) => {
      // An entry with no timestamp predates the clock; position alone decides.
      const age = entry.playedAt === undefined ? null : input.now - entry.playedAt;
      const inWindow = index < cooldown.plays || (age !== null && age < cooldown.ms);
      if (!inWindow) return;
      cooledKeys.add(entry.key);
      if (entry.altKey !== undefined) cooledKeys.add(entry.altKey);
      if (entry.identifier !== '') cooledIdentifiers.add(entry.identifier);
    });

    const exclusions: RecommendationExclusions = {
      trackKeys: new Set([
        ...cooledKeys,
        ...snapshot.queuedKeys,
        ...snapshot.reservedKeys,
        ...input.disliked,
        // A seed is what is playing or just played; recommending it back is
        // the most jarring repeat there is.
        ...seeds.map((seed) => identityOf(seed.artist, seed.title).key),
      ]),
      identifiers: new Set([...cooledIdentifiers, ...snapshot.queuedIdentifiers]),
    };

    /* --- KNOWN pool ------------------------------------------------------ */

    // Pass one: no tags, no I/O, over the whole pool.
    const roughlyRanked: ScoredFamiliar[] = [];
    const knownKeys = new Set<string>();
    let cooledOut = 0;
    for (const candidate of input.pool) {
      const scored = this.#withArtistPenalty(
        scoreFamiliar(candidate, input.scoringContext),
        input.dislikedArtists,
      );
      // Every known song is "known" for novelty purposes even when it is not
      // eligible to play right now — a discovery must never be a song the
      // listener merely heard too recently.
      knownKeys.add(scored.trackKey);
      if (cooledKeys.has(scored.trackKey) && !input.disliked.has(scored.trackKey)) {
        cooledOut += 1;
        continue;
      }
      if (exclusions.trackKeys.has(scored.trackKey)) continue;
      if (candidate.identifier !== '' && exclusions.identifiers.has(candidate.identifier)) continue;
      roughlyRanked.push(scored);
    }
    roughlyRanked.sort((a, b) => b.score - a.score);

    // Pass two: the shortlist gets its artists' tags — the same cached
    // vocabulary the discovery pool is scored with — so genre and language
    // fit can tell two known songs apart, not just "is it the seed artist".
    const familiarRanked = (
      await this.#enrichFamiliar(
        roughlyRanked.slice(0, this.#config.familiarTagShortlist),
        input.scoringContext,
      )
    )
      // Entries the enrichment left untouched already carry their penalty
      // from pass one; only rescored ones need it applied again.
      .map((entry) =>
        roughlyRanked.includes(entry)
          ? entry
          : this.#withArtistPenalty(entry, input.dislikedArtists),
      )
      .map((entry) => this.#withBehaviour(entry, input))
      .filter((entry) => entry.score >= this.#config.familiarMinScore)
      .sort((a, b) => b.score - a.score);
    const familiarStrong = familiarRanked.filter(
      (entry) => entry.score >= this.#config.familiarStrongScore,
    ).length;

    /* --- DISCOVERY pool -------------------------------------------------- */

    // Skipped when the plan cannot use a discovery anyway: the similarity
    // sweep is the expensive half of a generation pass.
    const wantsDiscovery = this.#config.interleave.discoveryEnabled && seeds.length > 0;
    const discoveryRanked = wantsDiscovery
      ? (
          await this.#discoveryCandidates(
            seeds,
            input.count,
            input.profile,
            input.recent,
            exclusions,
            knownKeys,
            snapshot,
            input.options,
          )
        ).flatMap((entry) => {
          const penalty = this.#artistPenaltyFor(entry.artistKey, input.dislikedArtists);
          // Behaviour on the artist only: a discovery is, by definition, a
          // song the room has never played.
          const boost =
            BEHAVIOUR_DISCOVERY_WEIGHT *
            neighbourhoodScore(
              input.behaviour,
              entry.trackKey,
              entry.artistKey,
              [],
              input.seedArtists,
            );
          if (penalty === 0 && boost === 0) return [entry];
          const final = Math.min(1, entry.breakdown.final - penalty + boost);
          return final >= this.#config.discoveryMinScore
            ? [{ ...entry, breakdown: { ...entry.breakdown, final } }]
            : [];
        })
      : [];

    return {
      exclusions,
      familiarRanked,
      familiarStrong,
      discoveryRanked,
      cooldown,
      cooledDown: cooledKeys.size,
      cooledOut,
    };
  }

  /** The room's dislikes: the session mirror plus the durable store, one read. */
  async #dislikes(
    listenerIds: readonly string[],
    snapshot: SessionSnapshot,
  ): Promise<{
    readonly keys: ReadonlySet<string>;
    readonly artistCounts: ReadonlyMap<string, number>;
  }> {
    const keys = new Set(snapshot.dislikedKeys);
    const store = this.#services.dislikes;
    if (store === undefined || listenerIds.length === 0) return { keys, artistCounts: new Map() };
    try {
      const stored = await store.dislikesFor(listenerIds);
      for (const key of stored.keys) keys.add(key);
      return { keys, artistCounts: stored.artistCounts };
    } catch (error) {
      logger.warn({ err: error }, 'Dislike store read failed; session mirror only');
      return { keys, artistCounts: new Map() };
    }
  }

  /**
   * A dislike is about one song. Its artist takes a small, capped penalty so
   * the room hears a little less of them — never a ban, because "I hate this
   * track" and "I hate this artist" are different statements.
   */
  #artistPenaltyFor(artistKey: string, dislikedArtists: ReadonlyMap<string, number>): number {
    const count = dislikedArtists.get(artistKey) ?? 0;
    return DISLIKED_ARTIST_PENALTY * Math.min(DISLIKED_ARTIST_PENALTY_CAP, count);
  }

  /**
   * Behavioural fit for a known song: how often the room has played it near
   * the seeds, saved it alongside them, or listed it with them. Recorded in
   * the breakdown so "why this one?" can name behaviour as the reason.
   */
  #withBehaviour(
    entry: ScoredFamiliar,
    input: {
      readonly behaviour: CooccurrenceSignals;
      readonly seedKeys: readonly string[];
      readonly seedArtists: readonly string[];
    },
  ): ScoredFamiliar {
    const fit = neighbourhoodScore(
      input.behaviour,
      entry.trackKey,
      entry.artistKey,
      input.seedKeys,
      input.seedArtists,
    );
    if (fit === 0) return entry;
    const score = Math.min(1, entry.score + BEHAVIOUR_FAMILIAR_WEIGHT * fit);
    return { ...entry, score, breakdown: { ...entry.breakdown, behaviour: fit, final: score } };
  }

  #withArtistPenalty(
    entry: ScoredFamiliar,
    dislikedArtists: ReadonlyMap<string, number>,
  ): ScoredFamiliar {
    const penalty = this.#artistPenaltyFor(entry.artistKey, dislikedArtists);
    if (penalty === 0) return entry;
    const score = Math.max(0, entry.score - penalty);
    return {
      ...entry,
      score,
      breakdown: { ...entry.breakdown, dislikedArtistPenalty: penalty, final: score },
    };
  }

  /**
   * Discovery candidates: the similarity engine's ranking with the listener's
   * entire known catalogue removed. A failure here means no discovery this
   * batch, never no music — the known pool does not depend on it.
   */
  async #discoveryCandidates(
    seeds: readonly TrackSeed[],
    count: number,
    profile: TasteProfile,
    recent: RecentContext,
    exclusions: RecommendationExclusions,
    knownKeys: ReadonlySet<string>,
    snapshot: SessionSnapshot,
    options: { readonly background: boolean },
  ): Promise<ScoredCandidate[]> {
    try {
      const result = await this.#services.recommender.rank({
        seeds,
        // A wider shortlist than the batch: each slot may burn through a few
        // candidates that fail to resolve.
        count: Math.max(count, 6),
        profile,
        recent,
        intent: MusicOrchestrator.continuationIntent(count),
        exclusions,
        knownKeys,
        session: { recentArtists: snapshot.recentArtists, artistFatigue: snapshot.artistFatigue },
        allowRerank: options.background,
      });
      return result.ranked.filter(
        (entry) => entry.breakdown.final >= this.#config.discoveryMinScore,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Discovery candidate generation failed; familiar only');
      return [];
    }
  }
}

/** The highest-valued signal among `keys` — the one-word answer to "why this song?". */
function primaryReason(breakdown: object, keys: readonly string[]): string {
  const values = breakdown as Readonly<Record<string, number | undefined>>;
  let best = 'score';
  let bestValue = -Infinity;
  for (const key of keys) {
    const value = values[key];
    if (value !== undefined && value > bestValue) {
      bestValue = value;
      best = key;
    }
  }
  return best;
}

/**
 * The language a seed set implies from its script alone. Free and never
 * wrong; the tag-based inference lives inside the recommender, which has the
 * lookups to pay for it.
 */
function seedLanguageOf(seeds: readonly TrackSeed[]): string | null {
  for (const seed of seeds.slice(0, 3)) {
    const language = languageFromText(`${seed.title} ${seed.artist}`);
    if (language !== null) return language;
  }
  return null;
}

/**
 * What one generation cycle has already committed to, across both pools.
 *
 * Two different candidates can be the same song under two spellings, and two
 * different songs can resolve to the same upload; both are caught here, on top
 * of the session-level exclusions the pools were already filtered by.
 */
class CycleState {
  readonly #keys = new Set<string>();
  readonly #identifiers = new Set<string>();
  readonly #artists = new Map<string, number>();
  readonly #exclusions: RecommendationExclusions;

  constructor(exclusions: RecommendationExclusions) {
    this.#exclusions = exclusions;
  }

  /**
   * Best remaining candidate, preferring an artist this cycle has not used.
   * One song per artist per batch is the default; the cap relaxes only when
   * every remaining candidate would breach it, because a repeat artist still
   * beats an unfilled slot.
   */
  takeBest(queue: SlotCandidate[]): SlotCandidate | null {
    const eligible = (entry: SlotCandidate): boolean =>
      !this.#keys.has(entry.key) && !this.#exclusions.trackKeys.has(entry.key);

    let index = queue.findIndex((entry) => eligible(entry) && !this.#artists.has(entry.artistKey));
    if (index === -1) index = queue.findIndex(eligible);
    if (index === -1) {
      queue.length = 0;
      return null;
    }
    const [taken] = queue.splice(index, 1);
    return taken ?? null;
  }

  isDuplicate(identifier: string, resolvedKey: string): boolean {
    return (
      this.#identifiers.has(identifier) ||
      this.#keys.has(resolvedKey) ||
      this.#exclusions.identifiers.has(identifier) ||
      this.#exclusions.trackKeys.has(resolvedKey)
    );
  }

  commit(candidate: SlotCandidate, identifier: string, resolvedKey: string): void {
    this.#keys.add(candidate.key);
    this.#keys.add(resolvedKey);
    this.#identifiers.add(identifier);
    this.#artists.set(candidate.artistKey, (this.#artists.get(candidate.artistKey) ?? 0) + 1);
  }
}
