/**
 * One interaction, handed from the command router to the bot that will run it.
 *
 * Discord posts every interaction to a single HTTPS endpoint. That endpoint
 * decides which bot owns the caller's voice channel and puts the interaction
 * on that bot's own Redis list; the bot picks it up, runs the command against
 * its own player, and replies straight to Discord. Nothing goes through the
 * primary, and no bot ever calls another.
 *
 * The reply works because interaction responses are authorised by the
 * interaction *token*, not by a bot token — so a player bot can answer a
 * command registered to a different application, and the answer still appears
 * under the one bot name everybody in the server recognises. That looks wrong
 * the first time you read it, and it is the load-bearing fact of the whole
 * design.
 */
import { z } from 'zod';

import { REDIS_NAMESPACE, redisKey } from '../constants/index.js';

import { deferralModeSchema } from './deferral.js';

/**
 * The queue one container reads its work from.
 *
 * A list rather than a pub/sub channel, deliberately. A dropped dashboard
 * click is invisible; a dropped slash command leaves somebody watching
 * "thinking…" until the interaction expires fifteen minutes later. A list
 * survives the second or two a container spends restarting.
 */
export function interactionQueueKey(botId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'interactions', botId);
}

/**
 * Proof that a bot took the work, written before it starts.
 *
 * The router has already told Discord "thinking…" by the time it publishes, so
 * a bot that never picks up leaves a reply that nothing will ever finish. This
 * is how the router finds that out in time to say something useful instead.
 */
export function interactionAckKey(interactionId: string): string {
  return redisKey(REDIS_NAMESPACE.PLAYER, 'ack', interactionId);
}

/** Long enough to outlive the router's check, short enough to forget quickly. */
export const INTERACTION_ACK_TTL_SECONDS = 30;

/**
 * How long queued work stays worth doing.
 *
 * An interaction token is valid for fifteen minutes, but nobody wants an answer
 * to a command they typed ten minutes ago. A container coming back from a
 * restart should run what is still relevant and drop the rest.
 */
export const INTERACTION_QUEUE_TTL_SECONDS = 60;
export const INTERACTION_MAX_AGE_MS = 15_000;

/**
 * Ids as Discord sends them.
 *
 * Plain strings rather than the branded snowflake schema: these come straight
 * off a payload Discord signed, so the regex would guard against nothing, and
 * branding a wire type makes every call site fight the compiler over values it
 * did not choose.
 */
const id = z.string().min(1).max(32);

/**
 * The interaction payload, forwarded verbatim.
 *
 * Loose on purpose. discord.js reconstructs a real interaction from this, and
 * it reads fields this schema has no opinion about — `entitlements`,
 * `app_permissions`, `authorizing_integration_owners`, `locale`. A strict
 * object would quietly drop them and the reconstruction would throw on a
 * field that was there when Discord sent it. Only what the router itself needs
 * is named; everything else rides along untouched.
 */
export const rawInteractionSchema = z.looseObject({
  id,
  application_id: id,
  token: z.string().min(1),
  type: z.number().int(),
  guild_id: id.optional(),
  channel_id: id.optional(),
});

export type RawInteraction = z.infer<typeof rawInteractionSchema>;

export const interactionEnvelopeSchema = z.object({
  payload: rawInteractionSchema,
  /**
   * The visibility the router ALREADY sent, not a mode to be recomputed.
   *
   * Deciding it twice invites the two answers to differ, and the failure is
   * ugly: `rejectGuard` deletes a public placeholder that was never public and
   * Discord answers 404.
   */
  deferral: deferralModeSchema,
  /**
   * The channel the router used to choose this bot.
   *
   * Carried as a canary, not as an instruction. The bot reads the caller's
   * voice channel from its own gateway cache exactly as it always has; this is
   * here so a disagreement between the two shows up in a log line instead of
   * as a room that mysteriously will not start.
   */
  voiceChannelId: id.nullable(),
  /** Router wall-clock at publish, so bot latency and route latency separate. */
  routedAt: z.number().int().positive(),
});

export type InteractionEnvelope = z.infer<typeof interactionEnvelopeSchema>;

export function encodeInteractionEnvelope(envelope: InteractionEnvelope): string {
  return JSON.stringify(envelope);
}

/** Parse and validate a queued interaction; null when malformed. */
export function decodeInteractionEnvelope(raw: string): InteractionEnvelope | null {
  try {
    const result = interactionEnvelopeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Discord's option types, for reading a subcommand out of a raw payload. */
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

interface RawOption {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly options?: readonly RawOption[];
}

/**
 * The invoked subcommand, unwrapping a group, or null when there is none.
 *
 * The only thing the router needs to read out of a command's options — it
 * decides visibility and nothing else. Everything richer stays on the bot,
 * where discord.js builds the whole option resolver for free.
 */
export function rawSubcommandName(data: unknown): string | null {
  const top = (data as { readonly options?: readonly RawOption[] } | null)?.options?.[0];
  if (top === undefined) return null;

  if (top.type === SUBCOMMAND) return typeof top.name === 'string' ? top.name : null;
  if (top.type === SUBCOMMAND_GROUP) {
    const nested = top.options?.[0];
    return typeof nested?.name === 'string' ? nested.name : null;
  }
  return null;
}
