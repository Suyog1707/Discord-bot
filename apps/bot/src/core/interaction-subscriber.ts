/**
 * Taking commands off this container's queue and running them.
 *
 * The other half of the command router. The router decided this bot owns the
 * caller's voice channel and put the interaction on its list; from here the
 * command runs exactly as it does on the gateway — same guards, same error
 * handling — and answers Discord directly.
 *
 * A blocking pop rather than a subscription, and its own connection because a
 * blocking read occupies one. Both are deliberate: pub/sub drops a message
 * nobody is listening for, and a dropped slash command is not silent to the
 * person who typed it. They watch "thinking…" until Discord gives up fifteen
 * minutes later.
 */
import {
  decodeInteractionEnvelope,
  INTERACTION_TYPE,
  INTERACTION_ACK_TTL_SECONDS,
  INTERACTION_MAX_AGE_MS,
  interactionAckKey,
  interactionQueueKey,
  type InteractionEnvelope,
} from '@discord-music/shared';
import { closeRedis, createRedisClient, type Redis } from '@discord-music/shared/redis';
import {
  Events,
  type APIChatInputApplicationCommandInteraction,
  type APIMessageComponentInteraction,
} from 'discord.js';

import { getLogger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';
import { dispatchChatInputCommand } from './dispatch-command.js';
import { dispatchMusicComponent, isMusicComponent } from './dispatch-component.js';
import {
  rehydrateChatInputInteraction,
  rehydrateComponentInteraction,
} from './interaction-rehydrate.js';

const logger = getLogger('routed-commands');

/**
 * How long each blocking read waits before looping.
 *
 * Long enough that an idle bot is not polling, short enough that a shutdown
 * does not sit waiting on a read that will never return.
 */
const BLOCK_SECONDS = 5;

export class InteractionSubscriber {
  /** Dedicated: a blocking pop occupies the connection it runs on. */
  readonly #reader: Redis;
  /** The shared client, for the writes the reader cannot make while blocked. */
  readonly #writer: Redis;
  readonly #client: BotClient;
  readonly #queueKey: string;
  #running = false;

  constructor(redisUrl: string, writer: Redis, client: BotClient) {
    this.#reader = createRedisClient({ url: redisUrl, logger });
    this.#writer = writer;
    this.#client = client;
    this.#queueKey = interactionQueueKey(client.identity.label);
  }

  async start(): Promise<void> {
    await this.#reader.connect();
    this.#running = true;
    void this.#loop();
    logger.info({ queue: this.#queueKey }, 'Watching for routed commands');
  }

  async stop(): Promise<void> {
    this.#running = false;
    await closeRedis(this.#reader);
  }

  #isRunning(): boolean {
    return this.#running;
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      try {
        const popped = await this.#reader.brpop(this.#queueKey, BLOCK_SECONDS);
        if (popped === null) continue;

        const [, raw] = popped;
        // Deliberately not awaited: the next command should not wait behind
        // this one's Lavalink round trip.
        void this.#handle(raw).catch((error: unknown) => {
          logger.error({ err: error }, 'Routed command failed');
        });
      } catch (error) {
        // Read through a method: the flag can be cleared by `stop()` while the
        // blocking read is in flight, which the loop condition cannot see.
        if (!this.#isRunning()) return;
        // A dropped connection reconnects underneath us; anything else is
        // worth a breath before trying again so a hard failure cannot spin.
        logger.warn({ err: error }, 'Routed command read failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async #handle(raw: string): Promise<void> {
    const envelope = decodeInteractionEnvelope(raw);
    if (envelope === null) {
      logger.warn({ raw: raw.slice(0, 200) }, 'Dropped malformed routed command');
      return;
    }

    const routeLatencyMs = Date.now() - envelope.routedAt;

    /**
     * Too old to be worth answering.
     *
     * A container coming back from a restart should run what is still relevant
     * and drop the rest — nobody wants a reply to a command they typed a
     * minute ago and long since gave up on.
     */
    if (routeLatencyMs > INTERACTION_MAX_AGE_MS) {
      logger.warn(
        { routeLatencyMs, interactionId: envelope.payload.id },
        'Dropped a routed command that waited too long',
      );
      return;
    }

    const guildId = envelope.payload.guild_id;
    /**
     * The guild has to be in this bot's own cache.
     *
     * `member` is patched into the cached `GuildMember`, and that is where
     * `.voice.channelId` comes from — without the guild it degrades to a raw
     * API object and the DJ guard's cast turns into a TypeError somewhere
     * confusing. The router should never send one of these; saying so plainly
     * beats discovering it three frames deep.
     */
    if (guildId === undefined || !this.#client.guilds.cache.has(guildId)) {
      logger.error(
        { guildId, interactionId: envelope.payload.id },
        'Routed a command for a guild this bot is not in; dropping',
      );
      return;
    }

    /**
     * Say we have it, before doing anything with it.
     *
     * The router has already told Discord "thinking…", so a command that
     * nobody picks up leaves a reply nothing will ever finish. This is how the
     * router finds that out in time to say something useful instead — which
     * means it has to be written first, not after the work.
     */
    await this.#writer
      .set(
        interactionAckKey(envelope.payload.id),
        this.#client.identity.label,
        'EX',
        INTERACTION_ACK_TTL_SECONDS,
      )
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'Could not acknowledge receipt of a routed command');
      });

    /**
     * Rehydration needs a connected client — it reads the guild and the member
     * out of its caches. Only reachable in the moment between the subscriber
     * starting and the gateway settling, and the router will not have chosen
     * this bot yet anyway, since presence is not published until after ready.
     */
    if (!this.#client.isReady()) {
      logger.warn({ interactionId: envelope.payload.id }, 'Not ready yet; dropping');
      return;
    }

    const routedLogger = logger.child({ routed: true, routeLatencyMs });

    /**
     * A button, not a command.
     *
     * Setting an interactions endpoint URL diverts everything an application
     * receives, so the controller's own buttons come this way too. They are
     * routed by the message they sit on rather than by the caller's voice
     * channel, and they land back on the bot that posted it.
     */
    if (envelope.payload.type === INTERACTION_TYPE.component) {
      const component = rehydrateComponentInteraction(
        this.#client,
        envelope.payload as unknown as APIMessageComponentInteraction,
      );
      if (isMusicComponent(component)) {
        await dispatchMusicComponent(this.#client, component, routedLogger);
        return;
      }

      /**
       * Anything else goes to the collectors.
       *
       * `/spotify playlists` holds its paging state in a closure behind a
       * component collector, and a collector listens for this event on this
       * client — so a routed click has to be put back into the same stream it
       * would have arrived on. The gateway handler ignores these, so nothing
       * handles it twice.
       */
      // Narrowed rather than cast: the event's type is the union of concrete
      // interactions, and these two are the only kinds anything here builds.
      if (component.isButton() || component.isStringSelectMenu()) {
        this.#client.emit(Events.InteractionCreate, component);
        routedLogger.debug({ customId: component.customId }, 'Routed component re-emitted');
      }
      return;
    }

    const interaction = rehydrateChatInputInteraction(
      this.#client,
      envelope.payload as unknown as APIChatInputApplicationCommandInteraction,
      envelope.deferral,
    );

    this.#warnOnVoiceDrift(envelope, interaction.member);

    await dispatchChatInputCommand(this.#client, interaction, routedLogger);
  }

  /**
   * The router's view of where the caller was, against this bot's own.
   *
   * A canary, not a correction. The cache is the one the command will actually
   * read, so it wins — but the two disagreeing is the signal that a voice
   * state is going stale somewhere, and it should show up as a log line rather
   * than as a room that mysteriously will not start.
   */
  #warnOnVoiceDrift(envelope: InteractionEnvelope, member: unknown): void {
    const routed = envelope.voiceChannelId;
    if (routed === null) return;

    const here = (member as { voice?: { channelId?: string | null } } | null)?.voice?.channelId;
    if (here === routed) return;

    logger.warn(
      { routed, here: here ?? null, interactionId: envelope.payload.id },
      "Router and gateway disagree about the caller's voice channel",
    );
  }
}
