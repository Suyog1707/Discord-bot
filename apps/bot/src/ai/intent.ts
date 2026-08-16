/**
 * Turning a sentence into a plan.
 *
 * This is the *only* place an LLM is consulted, and it runs once per user
 * request regardless of how many tracks that request ends up queueing. "Queue
 * 300 songs like this" is one parse and then three hundred locally-ranked picks
 * — never three hundred completions.
 *
 * The model's job is narrow on purpose: read the words, fill in a fixed
 * structure, name no songs. Song selection needs the listener's history and a
 * candidate pool, neither of which the model has, and asking it to guess titles
 * produces confident hallucinations of tracks that do not exist.
 *
 * Everything here has a keyword fallback. A missing API key, a rate limit or a
 * six-second timeout degrades to a parser that reads moods and numbers directly
 * out of the sentence — worse at nuance, but it never leaves the user without a
 * queue.
 */
import { z } from 'zod';

import { getLogger } from '../lib/logger.js';

import type { LLMProvider } from './llm/provider.js';

const logger = getLogger('intent');

/** Bounds the LLM's `quantity` so one parse cannot ask for an unbounded queue. */
const MAX_REQUESTED_TRACKS = 1_000;
const DEFAULT_RECOMMENDATION_COUNT = 10;

export const musicIntentSchema = z.object({
  /**
   * What the user is asking for.
   *
   * `play_specific` means they named something concrete and the normal resolve
   * path should handle it — the recommendation engine is not involved at all.
   * Routing cheap requests away from the expensive path is most of why the
   * intent step earns its latency.
   */
  intent: z
    .enum(['play_specific', 'recommend', 'generate_playlist', 'continue_taste', 'unknown'])
    .default('unknown'),
  /** A concrete title/artist to look up, when the user named one. */
  query: z.string().max(300).nullable().default(null),
  /** Free-text moods: "chill", "energetic", "sad". Matched against tags. */
  mood: z.array(z.string().max(40)).max(6).default([]),
  /** Genres: "lofi", "punjabi hip hop", "synthwave". */
  genre: z.array(z.string().max(40)).max(6).default([]),
  /** What they are doing: "studying", "gym", "driving". Steers mood inference. */
  activity: z.string().max(60).nullable().default(null),
  /** Language name when stated ("hindi", "english"). Never guessed by the model. */
  language: z.string().max(40).nullable().default(null),
  /** Era hint: "90s", "2000s", "recent". */
  era: z.string().max(40).nullable().default(null),
  /** Artists to steer toward. */
  artists: z.array(z.string().max(100)).max(10).default([]),
  /** Artists to keep out — "not the same artist", "no Drake". */
  excludeArtists: z.array(z.string().max(100)).max(10).default([]),
  /** How many tracks to queue. */
  quantity: z.number().int().min(1).max(MAX_REQUESTED_TRACKS).default(DEFAULT_RECOMMENDATION_COUNT),
  /** Weight this listener's own history rather than generic popularity. */
  usePersonalHistory: z.boolean().default(true),
  /** "songs I haven't heard recently" — push the recency penalty up. */
  avoidRecent: z.boolean().default(false),
  /** "mix it up", "not all the same artist" — tighten the per-artist cap. */
  artistDiversity: z.boolean().default(true),
});

export type MusicIntent = z.infer<typeof musicIntentSchema>;

export interface IntentResult {
  readonly intent: MusicIntent;
  /** Which path produced it. Surfaced in metrics, not to users. */
  readonly source: 'llm' | 'heuristic';
  readonly latencyMs: number;
}

const SYSTEM_PROMPT = `You convert a Discord music request into JSON. Respond with the object only.

Fields: intent (play_specific|recommend|generate_playlist|continue_taste|unknown),
query (string|null), mood (string[]), genre (string[]), activity (string|null),
language (string|null), era (string|null), artists (string[]),
excludeArtists (string[]), quantity (int), usePersonalHistory (bool),
avoidRecent (bool), artistDiversity (bool).

Rules:
- Never invent song titles. query holds only what the user literally named.
- intent is play_specific when they named a track, album or artist to play now.
- intent is continue_taste for "more like this" or "keep the vibe going".
- quantity defaults to 10; read a stated number ("queue 250 songs" -> 250).
- language only when the user says it. Do not infer it from an artist's name.
- avoidRecent true for "haven't heard", "something new", "fresh".
- artistDiversity false only when they ask for one artist specifically.`;

/** Moods the fallback parser can recognise, mapped to the tags they imply. */
const MOOD_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  chill: ['chill', 'chillout'],
  relaxing: ['chill', 'mellow'],
  relaxed: ['chill', 'mellow'],
  calm: ['chill', 'ambient'],
  sad: ['sad', 'melancholy'],
  emotional: ['sad', 'emotional'],
  happy: ['happy', 'feel good'],
  energetic: ['energetic', 'upbeat'],
  hype: ['energetic', 'party'],
  party: ['party', 'dance'],
  romantic: ['romantic', 'love'],
  workout: ['workout', 'energetic'],
  gym: ['workout', 'energetic'],
  study: ['study', 'instrumental'],
  studying: ['study', 'instrumental'],
  focus: ['study', 'instrumental'],
  sleep: ['sleep', 'ambient'],
  night: ['chill', 'late night'],
};

/** Languages the fallback parser recognises by name. */
const LANGUAGE_KEYWORDS = [
  'hindi',
  'punjabi',
  'english',
  'tamil',
  'telugu',
  'bengali',
  'marathi',
  'urdu',
  'spanish',
  'korean',
  'japanese',
  'french',
  'arabic',
];

/**
 * Parse without a model.
 *
 * Exported because it is the failsafe path and deserves its own tests — the LLM
 * being down is exactly when nobody is around to notice this regressed.
 */
export function parseIntentHeuristically(raw: string): MusicIntent {
  const text = raw.toLowerCase().trim();

  const mood = new Set<string>();
  for (const [keyword, tags] of Object.entries(MOOD_KEYWORDS)) {
    if (new RegExp(`\\b${keyword}\\b`, 'u').test(text)) for (const tag of tags) mood.add(tag);
  }

  const language = LANGUAGE_KEYWORDS.find((name) => new RegExp(`\\b${name}\\b`, 'u').test(text));

  // "queue 250 songs", "make me a playlist of 100" — take the first plain
  // integer, which is nearly always the count in a request phrased this way.
  const quantityMatch = /\b(\d{1,4})\b/u.exec(text);
  const parsedQuantity =
    quantityMatch === null ? null : Number.parseInt(quantityMatch[1] ?? '', 10);
  const quantity =
    parsedQuantity !== null && Number.isFinite(parsedQuantity)
      ? Math.min(Math.max(parsedQuantity, 1), MAX_REQUESTED_TRACKS)
      : DEFAULT_RECOMMENDATION_COUNT;

  const continuesTaste =
    /\b(more like|similar|keep (it |the )?(going|vibe)|same (vibe|taste))\b/u.test(text);
  const wantsPlaylist = /\b(playlist|queue \d+|\d+ songs)\b/u.test(text);

  const intent: MusicIntent['intent'] = continuesTaste
    ? 'continue_taste'
    : wantsPlaylist
      ? 'generate_playlist'
      : mood.size > 0 || language !== undefined
        ? 'recommend'
        : 'unknown';

  return musicIntentSchema.parse({
    intent,
    mood: [...mood],
    language: language ?? null,
    quantity,
    avoidRecent: /\b(haven'?t heard|something new|fresh|new to me)\b/u.test(text),
    // "similar but not the same artist" is the phrasing this exists to catch.
    artistDiversity: !/\b(only|just) (this|that) artist\b/u.test(text),
  });
}

export class IntentService {
  readonly #provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.#provider = provider;
  }

  /**
   * One completion, validated, with the keyword parser behind it.
   *
   * A malformed or partial object is not a failure: zod fills every field from
   * its default, so a model that returns only `{"mood":["chill"]}` still yields a
   * usable intent. Only a thrown request or unparseable text falls back.
   */
  async parse(raw: string): Promise<IntentResult> {
    const startedAt = Date.now();

    if (!this.#provider.available) {
      return {
        intent: parseIntentHeuristically(raw),
        source: 'heuristic',
        latencyMs: Date.now() - startedAt,
      };
    }

    try {
      const result = await this.#provider.complete({
        system: SYSTEM_PROMPT,
        user: raw,
        json: true,
        maxTokens: 400,
      });

      const parsed = musicIntentSchema.safeParse(extractJson(result.text));
      if (!parsed.success) throw new Error('Model output did not match the intent schema.');

      logger.debug(
        { provider: this.#provider.name, intent: parsed.data.intent, latencyMs: result.latencyMs },
        'Intent parsed',
      );
      return { intent: parsed.data, source: 'llm', latencyMs: Date.now() - startedAt };
    } catch (error) {
      logger.warn({ err: error, provider: this.#provider.name }, 'Intent parse fell back');
      return {
        intent: parseIntentHeuristically(raw),
        source: 'heuristic',
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}

/**
 * Pull the JSON object out of a completion.
 *
 * Even with `response_format: json_object` some models wrap the result in a
 * markdown fence or a sentence of preamble, and losing an otherwise-good parse
 * to a stray backtick is not worth it.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
