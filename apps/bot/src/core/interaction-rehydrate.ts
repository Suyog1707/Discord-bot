/**
 * Turning a routed payload back into a real interaction.
 *
 * A command that arrives over Redis is the same JSON Discord would have sent
 * down the gateway — so rather than adapting every call site to a second kind
 * of interaction, the payload is handed to discord.js and it builds the real
 * thing. Thirty-five command files are untouched.
 *
 * The reason this works at all, and it looks wrong until you check it:
 * `BaseInteraction` takes `applicationId` from the **payload**, not from the
 * client, and `CommandInteraction` builds its reply webhook from that with
 * `auth: false`. So a player bot replying to a command registered to the
 * primary's application sends
 * `PATCH /webhooks/{payload.application_id}/{token}/messages/@original` —
 * exactly right, authorised by the interaction token rather than by any bot
 * token. `client.application.id` is never consulted on the reply path.
 *
 * That is undocumented-but-stable behaviour, which is why `discord.js` is
 * pinned to an exact version in `apps/bot/package.json` — no caret — and why
 * `interaction-rehydrate.test.ts` asserts the outgoing route carries the
 * payload's application id. Between them, a version bump that changed this
 * becomes a red test rather than every routed reply 404ing in production.
 */
import type { DeferralMode } from '@discord-music/shared';
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ComponentType,
  StringSelectMenuInteraction,
  type APIChatInputApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  type Client,
  type MessageComponentInteraction,
} from 'discord.js';

/**
 * discord.js marks interaction constructors as internal, because the gateway
 * is normally the only thing that builds one. A routed command is the same
 * payload arriving by another road, so the constructor is reached through one
 * documented cast rather than by reimplementing the class — which would mean
 * reimplementing the option resolver, the reply webhook and the error types
 * with it.
 */
type InteractionConstructor = new (
  client: Client<true>,
  data: APIChatInputApplicationCommandInteraction,
) => ChatInputCommandInteraction;

const Construct = ChatInputCommandInteraction as unknown as InteractionConstructor;

/**
 * Rebuild an interaction the router already acknowledged.
 *
 * @param deferral What the router actually sent, not what this bot would have
 * chosen. If the two disagreed, `rejectGuard` would try to delete a public
 * placeholder that was never public and Discord would answer 404.
 */
export function rehydrateChatInputInteraction(
  client: Client<true>,
  payload: APIChatInputApplicationCommandInteraction,
  deferral: DeferralMode,
): ChatInputCommandInteraction {
  const interaction = new Construct(client, payload);

  /**
   * Reflect the acknowledgement that has already gone out.
   *
   * These are plain writable fields, not getters, and setting them is what
   * makes every branch in `interaction-response.ts` choose the same path it
   * would have chosen on the gateway: `acknowledge` short-circuits,
   * `editReply` and `followUp` pass their "already acknowledged" assertions,
   * and `rejectGuard` reads `ephemeral` to decide whether the placeholder is
   * public and therefore has to be deleted.
   */
  interaction.deferred = true;
  interaction.replied = false;
  interaction.ephemeral = deferral === 'ephemeral';

  return interaction;
}

type ComponentConstructor = new (
  client: Client<true>,
  data: APIMessageComponentInteraction,
) => MessageComponentInteraction;

/**
 * The same trick for a button or a select menu.
 *
 * Needed because setting an interactions endpoint URL diverts *all* of an
 * application's interactions, not only its commands — so the primary's own
 * controller buttons arrive this way too, and have to keep working.
 *
 * Marked deferred rather than ephemeral: the router answers a component with a
 * deferred *update*, which changes nothing on screen, so `editReply` edits the
 * message the button sits on and `followUp` speaks beside it.
 */
export function rehydrateComponentInteraction(
  client: Client<true>,
  payload: APIMessageComponentInteraction,
): MessageComponentInteraction {
  const Component = (payload.data.component_type === ComponentType.StringSelect
    ? StringSelectMenuInteraction
    : ButtonInteraction) as unknown as ComponentConstructor;

  const interaction = new Component(client, payload);
  interaction.deferred = true;
  interaction.replied = false;
  interaction.ephemeral = false;

  return interaction;
}
