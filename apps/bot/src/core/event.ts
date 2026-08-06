/**
 * Event-handler contract.
 *
 * `defineEvent` keeps the payload strongly typed against discord.js's
 * `ClientEvents` map, so a handler for `guildCreate` cannot accidentally be
 * written against a `Message`.
 */
import type { ClientEvents } from 'discord.js';

import type { Logger } from '../lib/logger.js';
import type { BotClient } from './bot-client.js';

export interface EventContext {
  readonly client: BotClient;
  /** Logger tagged with the event name. */
  readonly logger: Logger;
}

export interface EventDefinition<TEvent extends keyof ClientEvents = keyof ClientEvents> {
  readonly name: TEvent;
  /** Detach after the first invocation (e.g. `clientReady`). */
  readonly once?: boolean;
  execute(context: EventContext, ...args: ClientEvents[TEvent]): Promise<void> | void;
}

export function defineEvent<TEvent extends keyof ClientEvents>(
  definition: EventDefinition<TEvent>,
): EventDefinition<TEvent> {
  return definition;
}

/** Erased form the registry stores, since handlers vary by event name. */
export type AnyEventDefinition = EventDefinition;
