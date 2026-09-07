/**
 * Interaction acknowledgement and response safety.
 *
 * Discord invalidates an interaction that is not acknowledged within three
 * seconds, reporting `10062 Unknown interaction` on every later attempt to use
 * it. These helpers own that lifecycle in one place: acknowledging up front,
 * choosing the correct response verb for the current state, and treating a dead
 * interaction as terminal rather than something to retry into a second failure.
 */
import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from 'discord.js';

import type { Logger } from '../lib/logger.js';

/** Interaction ids already dispatched, newest last so the oldest evicts first. */
const claimedInteractions = new Set<string>();
const CLAIMED_MAX = 2_000;

/**
 * Take ownership of an interaction id.
 *
 * @returns `false` when this id was already dispatched in this process.
 */
export function claimInteraction(id: string): boolean {
  if (claimedInteractions.has(id)) return false;

  if (claimedInteractions.size >= CLAIMED_MAX) {
    const oldest = claimedInteractions.values().next();
    if (!(oldest.done ?? false)) claimedInteractions.delete(oldest.value);
  }
  claimedInteractions.add(id);
  return true;
}

/** Discord: the interaction id is unknown, or its acknowledgement window closed. */
const UNKNOWN_INTERACTION = 10062;
/** Discord: this interaction was already acknowledged. */
const ALREADY_ACKNOWLEDGED = 40060;

/**
 * True when Discord has told us this interaction can no longer be responded to.
 *
 * Both codes mean the same thing for our purposes: the token is spent or dead,
 * and every further response attempt will fail the same way. Retrying one is
 * how a single `10062` turns into a pair of them in the logs.
 */
export function isDeadInteraction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === UNKNOWN_INTERACTION || code === ALREADY_ACKNOWLEDGED;
}

/**
 * Reply with an error, choosing the correct method for the interaction's state.
 *
 * Once an interaction has been replied to or deferred, `reply()` throws
 * `InteractionAlreadyReplied`; this picks `followUp`/`editReply` accordingly.
 *
 * Never throws. A dead interaction is reported as such and abandoned rather
 * than retried through another endpoint, because the retry only produces a
 * second identical failure — the "two 10062s per incident" pattern.
 *
 * @returns Whether the message reached the user.
 */
export async function replyWithError(
  interaction: Extract<Interaction, { replied: boolean }>,
  message: string,
  logger: Logger,
): Promise<boolean> {
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;

  try {
    if (interaction.deferred) {
      await interaction.editReply({ content: message });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    return true;
  } catch (error) {
    if (isDeadInteraction(error)) {
      logger.warn(
        { discordCode: (error as { code?: unknown }).code },
        'Interaction is no longer valid; skipping the error reply',
      );
      return false;
    }
    logger.error({ err: error }, 'Failed to deliver the error reply');
    return false;
  }
}

/**
 * Report a rejected guard, keeping the message private.
 *
 * A command that declared public deferral already has a visible "thinking"
 * message by the time guards run, so the placeholder is removed and the reason
 * sent as an ephemeral follow-up. That keeps cooldown and DJ rejections exactly
 * as private as they were when commands acknowledged themselves.
 */
export async function rejectGuard(
  interaction: ChatInputCommandInteraction,
  message: string,
  logger: Logger,
): Promise<void> {
  if (interaction.deferred && !interaction.ephemeral) {
    try {
      await interaction.deleteReply();
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      return;
    } catch (error) {
      if (isDeadInteraction(error)) {
        logger.warn('Interaction is no longer valid; skipping the guard rejection');
        return;
      }
      // Fall through: the placeholder may still be editable.
      logger.debug({ err: error }, 'Ephemeral guard rejection failed; editing in place');
    }
  }
  await replyWithError(interaction, message, logger);
}

/**
 * Acknowledge the interaction before anything that can block.
 *
 * This is the whole reason `10062` was reachable: guards consult Redis and
 * Postgres, both remote in production, so a command that acknowledged itself
 * only did so after two internet round-trips. Any spike there spent the
 * three-second window before `deferReply` was ever called.
 *
 * @returns Whether the interaction is still usable.
 */
export async function acknowledge(
  interaction: ChatInputCommandInteraction,
  mode: 'public' | 'ephemeral',
  logger: Logger,
): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;

  try {
    await interaction.deferReply(mode === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {});
    return true;
  } catch (error) {
    if (isDeadInteraction(error)) {
      logger.warn(
        {
          discordCode: (error as { code?: unknown }).code,
          interactionAgeMs: Date.now() - interaction.createdTimestamp,
        },
        'Interaction expired before it could be acknowledged',
      );
      return false;
    }
    throw error;
  }
}
