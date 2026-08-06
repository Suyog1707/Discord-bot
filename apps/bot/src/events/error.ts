import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/**
 * Gateway-level errors.
 *
 * discord.js emits `error` for socket failures it recovers from internally. A
 * listener must exist regardless: an unhandled `error` event on an EventEmitter
 * throws and takes the process down.
 */
export default defineEvent({
  name: Events.Error,
  execute({ logger }, error) {
    logger.error({ err: error }, 'Discord client error');
  },
});
