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

export interface GroqOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
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
    const { apiKey, model, timeoutMs } = this.#options;

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
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        max_tokens: request.maxTokens ?? 512,
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
