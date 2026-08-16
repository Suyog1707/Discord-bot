/**
 * The seam between this bot and whichever LLM is behind it.
 *
 * Only one thing in the whole recommendation stack calls an LLM — intent
 * parsing — and it goes through this interface. That is deliberate: song
 * selection is a ranking problem over hundreds of candidates, and routing it
 * through a language model would cost one network round trip per track. The LLM
 * reads the sentence; the engine picks the music.
 *
 * Keeping the surface this small is what makes the provider swappable. A new
 * backend needs one file implementing `complete`, and nothing above it changes.
 */

export interface LLMRequest {
  /** Role and rules. Kept short and stable so providers can cache the prefix. */
  readonly system: string;
  /** The user's actual words, plus whatever minimal context the task needs. */
  readonly user: string;
  readonly maxTokens?: number;
  /**
   * Ask the provider to emit a JSON object. Providers that cannot enforce this
   * should still set it — the caller validates the result either way, so this is
   * a hint that improves the hit rate rather than a guarantee it can rely on.
   */
  readonly json?: boolean;
}

export interface LLMResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface LLMProvider {
  /** Short identifier for logs and metrics, e.g. `"groq"`. */
  readonly name: string;
  /**
   * False when the provider has no credentials or is otherwise unusable.
   * Callers check this to skip straight to their fallback instead of paying a
   * timeout to discover the same thing.
   */
  readonly available: boolean;
  /**
   * Resolves with the completion, or rejects. Implementations must enforce
   * their own deadline — a caller waiting on an intent parse has a human on the
   * other end of a slash command.
   */
  complete(request: LLMRequest): Promise<LLMResult>;
}

/** Stand-in used when nothing is configured, so callers never branch on null. */
export const NULL_PROVIDER: LLMProvider = {
  name: 'none',
  available: false,
  complete(): Promise<LLMResult> {
    return Promise.reject(new Error('No LLM provider is configured.'));
  },
};
