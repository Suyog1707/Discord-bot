/**
 * Event registry.
 *
 * Mirrors `CommandRegistry`: discovers `src/events/*.ts`, validates the default
 * export, and binds each handler to the client with a wrapper that catches
 * rejections. An unhandled rejection inside a discord.js listener would
 * otherwise terminate the process.
 */
import type { Client, ClientEvents } from 'discord.js';

import { getLogger } from '../lib/logger.js';
import type { BotClient } from './bot-client.js';
import { collectModuleFiles } from './command-registry.js';
import type { AnyEventDefinition, EventContext } from './event.js';

const logger = getLogger('event-registry');

function isEventDefinition(value: unknown): value is AnyEventDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AnyEventDefinition>;
  return typeof candidate.name === 'string' && typeof candidate.execute === 'function';
}

export class EventRegistry {
  readonly #events: AnyEventDefinition[] = [];

  get size(): number {
    return this.#events.length;
  }

  values(): readonly AnyEventDefinition[] {
    return [...this.#events];
  }

  register(event: AnyEventDefinition): void {
    this.#events.push(event);
  }

  /** Load every event module under `directory`, skipping ones that fail. */
  async loadFrom(directory: string): Promise<number> {
    const { pathToFileURL } = await import('node:url');
    const files = await collectModuleFiles(directory);
    let loaded = 0;

    for (const file of files) {
      try {
        const module: unknown = await import(pathToFileURL(file).href);
        const exported = (module as { default?: unknown }).default;

        if (!isEventDefinition(exported)) {
          logger.warn({ file }, 'Skipping file: default export is not a valid event definition');
          continue;
        }

        this.register(exported);
        loaded += 1;
        logger.debug({ event: exported.name, once: exported.once ?? false }, 'Event loaded');
      } catch (error) {
        logger.error({ err: error, file }, 'Failed to load event');
      }
    }

    logger.info({ loaded, discovered: files.length }, 'Event loading complete');
    return loaded;
  }

  /**
   * Attach every registered handler to `client`.
   *
   * Handlers are wrapped so a thrown error or rejected promise is logged rather
   * than escaping as an unhandled rejection.
   */
  attach(client: BotClient): void {
    for (const event of this.#events) {
      const context: EventContext = {
        client,
        logger: logger.child({ event: event.name }),
      };

      const handler = (...args: ClientEvents[keyof ClientEvents]): void => {
        void (async () => {
          try {
            await event.execute(context, ...args);
          } catch (error) {
            context.logger.error({ err: error }, 'Unhandled error in event handler');
          }
        })();
      };

      // `Client` is typed per-event; the registry is intentionally erased.
      const target = client as Client;
      if (event.once === true) {
        target.once(event.name, handler);
      } else {
        target.on(event.name, handler);
      }
    }

    logger.info({ attached: this.#events.length }, 'Event handlers attached');
  }
}
