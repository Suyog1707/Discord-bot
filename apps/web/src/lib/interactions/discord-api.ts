import 'server-only';

/**
 * The two things the router asks Discord for directly.
 *
 * Everything else it needs is in Redis or Postgres. These are the exceptions:
 * where somebody is standing, which only Discord knows, and how to say
 * something after the deferral has already gone out.
 */
import { getLogger } from '@/lib/logger';

const DISCORD_API = 'https://discord.com/api/v10';

/** Bounded, because this sits between a user pressing enter and anything happening. */
const REQUEST_TIMEOUT_MS = 3_000;

/** What a voice-state lookup found. */
export type VoiceLookup =
  /** They are in this channel. */
  | { readonly kind: 'in-voice'; readonly voiceChannelId: string }
  /** Discord says they are in none. */
  | { readonly kind: 'not-in-voice' }
  /**
   * Discord could not say — an outage, a rate limit, a revoked token.
   *
   * Deliberately not folded into `not-in-voice`. Telling somebody to join a
   * voice channel they are already sitting in is the kind of wrong answer that
   * sends them to look for a bug in the wrong place.
   */
  | { readonly kind: 'unknown' };

/**
 * Which voice channel a member is in.
 *
 * The interaction payload carries the member — their roles, their permissions,
 * their nickname — but not their voice state, and there is no way to derive it
 * from what Discord sends. Hence a bot token in the dashboard's environment,
 * used for this one read and nothing else.
 */
export async function fetchVoiceChannelId(
  botToken: string,
  guildId: string,
  userId: string,
): Promise<VoiceLookup> {
  const logger = getLogger('interactions');

  try {
    const response = await fetch(`${DISCORD_API}/guilds/${guildId}/voice-states/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 404 is the honest "they are not connected to anything" — the voice state
    // simply does not exist. Every other failure is ours or Discord's.
    if (response.status === 404) return { kind: 'not-in-voice' };
    if (!response.ok) {
      logger.warn(
        { status: response.status, guildId },
        'Voice state lookup failed; routing without a room',
      );
      return { kind: 'unknown' };
    }

    const state = (await response.json()) as { readonly channel_id?: unknown };
    return typeof state.channel_id === 'string'
      ? { kind: 'in-voice', voiceChannelId: state.channel_id }
      : { kind: 'not-in-voice' };
  } catch (error) {
    logger.warn({ err: error, guildId }, 'Voice state lookup failed; routing without a room');
    return { kind: 'unknown' };
  }
}

/**
 * Replace the "thinking…" placeholder with something to read.
 *
 * Authorised by the interaction token rather than a bot token — which is also
 * what lets a player bot answer a command registered to a different
 * application. `auth: false` is not an oversight here; sending a bot token
 * would be.
 */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  body: { readonly content: string; readonly flags?: number },
): Promise<void> {
  try {
    const response = await fetch(
      `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      getLogger('interactions').warn(
        { status: response.status },
        'Could not edit the deferred reply',
      );
    }
  } catch (error) {
    // Nothing useful is left to do: the user sees the placeholder time out.
    getLogger('interactions').warn({ err: error }, 'Could not edit the deferred reply');
  }
}
