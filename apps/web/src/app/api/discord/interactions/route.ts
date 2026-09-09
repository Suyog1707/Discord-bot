/**
 * POST /api/discord/interactions — every slash command, from Discord.
 *
 * The command router. Discord posts each interaction here rather than sending
 * it down a bot's gateway connection, and this decides which of the player
 * bots should run it, hands it over, and gets out of the way. The bot answers
 * Discord directly afterwards, using the interaction token — so nothing routes
 * back through here, and no bot ever calls another.
 *
 * The shape of this file is the design. It does the least it possibly can
 * before answering, because Discord invalidates an interaction that is not
 * acknowledged within three seconds, and everything interesting — a Discord
 * round trip, two Postgres reads, several Redis calls — happens in `after()`
 * once the acknowledgement is already on its way.
 *
 * Unauthenticated by session, deliberately: the Ed25519 signature over the
 * body is the only thing separating a real command from a forgery, which is
 * why `verifyDiscordSignature` runs before anything else looks at the payload.
 */
import { after, NextResponse } from 'next/server';

import { verifyDiscordSignature } from '@/lib/discord/verify-signature';
import { getEnv } from '@/lib/env';
import { deferralFor } from '@/lib/interactions/deferral';
import { getLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Bounds the `after()` work; the routing itself should finish in well under 2s. */
export const maxDuration = 30;

/** Discord's interaction types. */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const AUTOCOMPLETE = 4;
const MODAL_SUBMIT = 5;

/** Discord's response types. */
const PONG = 1;
const DEFERRED_MESSAGE = 5;
const AUTOCOMPLETE_RESULT = 8;

/** Only the caller sees it. */
const EPHEMERAL = 64;

export async function POST(request: Request): Promise<Response> {
  const logger = getLogger('interactions');

  /**
   * The body, before anything else touches it.
   *
   * A request body is a one-shot stream, and the signature is over the exact
   * bytes Discord sent — parsing first and re-serialising produces different
   * bytes and every signature fails. This ordering is not a style choice.
   */
  const rawBody = await request.text();

  const publicKey = getEnv().BOT_PUBLIC_KEY;
  if (publicKey === undefined) {
    // Refusing outright rather than serving unverified: an endpoint that
    // cannot check signatures is an endpoint anybody can drive.
    logger.error('BOT_PUBLIC_KEY is not set; refusing to handle interactions');
    return new NextResponse('interactions endpoint is not configured', { status: 503 });
  }

  const verified = verifyDiscordSignature({
    rawBody,
    signature: request.headers.get('x-signature-ed25519'),
    timestamp: request.headers.get('x-signature-timestamp'),
    publicKey,
  });

  /**
   * 401, not 400.
   *
   * Discord probes this endpoint with deliberately-invalid signatures when the
   * URL is saved and refuses to accept it unless they are rejected with 401.
   * That probe is also the first real adversarial test this code ever gets.
   */
  if (!verified) return new NextResponse('invalid request signature', { status: 401 });

  const interaction = JSON.parse(rawBody) as { readonly type?: number };
  // A payload with no type is malformed; `-1` falls to the same refusal as any
  // type this router does not serve.
  const type = interaction.type ?? -1;

  switch (type) {
    case PING:
      // The handshake Discord performs when the URL is saved.
      return NextResponse.json({ type: PONG });

    case APPLICATION_COMMAND: {
      const deferral = await deferralFor(interaction);

      /**
       * Answer first, route after.
       *
       * `after()` keeps the invocation alive until the work finishes, so this
       * is not fire-and-forget onto a dying process. Importing the router
       * lazily keeps Prisma and the fleet code out of the module graph of the
       * paths that never need them — which is what keeps a cold start on the
       * autocomplete path survivable.
       */
      after(async () => {
        const { routeCommand } = await import('@/lib/interactions/route-command');
        await routeCommand({
          payload: interaction as Parameters<typeof routeCommand>[0]['payload'],
          deferral,
        });
      });

      return NextResponse.json({
        type: DEFERRED_MESSAGE,
        data: deferral === 'ephemeral' ? { flags: EPHEMERAL } : {},
      });
    }

    case AUTOCOMPLETE:
      /**
       * Answered here or not at all — there is no deferral for autocomplete,
       * so a round trip to a bot cannot fit in the budget. Suggestions arrive
       * in a later change; an empty list is what the command already falls back
       * to when Spotify is unconfigured, and free text keeps working.
       */
      return NextResponse.json({ type: AUTOCOMPLETE_RESULT, data: { choices: [] } });

    case MESSAGE_COMPONENT:
    case MODAL_SUBMIT:
      // Routed by the message they belong to rather than by the caller's voice
      // channel, which is a different lookup and lands in a later change.
      logger.warn({ type }, 'Component interaction reached the router');
      return NextResponse.json({
        type: DEFERRED_MESSAGE,
        data: { flags: EPHEMERAL },
      });

    default:
      logger.warn({ type }, 'Unhandled interaction type');
      return new NextResponse('unsupported interaction type', { status: 400 });
  }
}
