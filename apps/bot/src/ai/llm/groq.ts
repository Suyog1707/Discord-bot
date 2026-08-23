/**
 * Groq — the primary provider, chosen for latency.
 *
 * Intent parsing sits directly between a user pressing enter on a slash command
 * and the bot doing anything, and Discord gives an interaction three seconds
 * before it has to be deferred. Groq's inference speed is the reason this is
 * viable as a synchronous step at all.
 *
 * The API is OpenAI-shaped, which is a fact about Groq rather than a design
 * choice here — nothing outside this file knows about it.
 */
import { getLogger } from '../../lib/logger.js';

import type { LLMProvider, LLMRequest, LLMResult } from './provider.js';

const logger = getLogger('groq');

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Case-insensitive: Groq accepts "JSON" as readily as "json". */
const JSON_MENTIONED = /json/i;

export type GroqReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface GroqOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /**
   * `none` omits the parameter entirely rather than sending a low value.
   * Models without a reasoning mode answer `reasoning_effort` with a 400, so
   * "don't think" and "can't think" are not the same request.
   */
  readonly reasoningEffort: GroqReasoningEffort;
}

interface ChatCompletionBody {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly error?: { readonly message?: string };
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  readonly #options: GroqOptions;

  constructor(options: GroqOptions) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#options.apiKey.length > 0;
  }

  async complete(request: LLMRequest): Promise<LLMResult> {
    const startedAt = Date.now();
    const { apiKey, model, timeoutMs, reasoningEffort } = this.#options;

    // Groq rejects `response_format: json_object` unless the word "json"
    // appears somewhere in the messages — a 400, not a warning. The constraint
    // travels with the response format rather than with any one prompt, so it
    // is enforced here instead of being left as a rule every caller has to
    // remember: `rerank` asked for JSON while describing the shape as a literal
    // object and never saying the word, and every call it made failed.
    const system =
      request.json === true && !JSON_MENTIONED.test(`${request.system} ${request.user}`)
        ? `${request.system}\n\nRespond with a single JSON object.`
        : request.system;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        // Never logged: the catch below records the status, never the headers.
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: request.user },
        ],
        max_tokens: request.maxTokens ?? 512,
        // A reasoning model spends `max_tokens` on its own thinking before it
        // writes a word of the reply, so left unbounded it can exhaust the
        // budget and hand back an empty completion.
        ...(reasoningEffort === 'none' ? {} : { reasoning_effort: reasoningEffort }),
        // Intent extraction should be reproducible: the same sentence must not
        // resolve to a different mood on a retry.
        temperature: 0,
        ...(request.json === true ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Read the body for the reason, but surface only status and message —
      // never the request, which would echo the key back into the logs.
      let detail = '';
      try {
        const body = (await response.json()) as ChatCompletionBody;
        detail = body.error?.message ?? '';
      } catch {
        detail = '';
      }
      logger.warn({ status: response.status, detail }, 'Groq completion failed');
      throw new Error(`Groq responded ${String(response.status)}`);
    }

    const body = (await response.json()) as ChatCompletionBody;
    const text = body.choices?.[0]?.message?.content ?? '';
    if (text.length === 0) throw new Error('Groq returned an empty completion.');

    const latencyMs = Date.now() - startedAt;
    logger.debug({ model, latencyMs }, 'Groq completion');
    return { text, model, latencyMs };
  }
}
