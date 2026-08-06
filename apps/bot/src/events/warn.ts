import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/** Non-fatal gateway warnings (deprecated intents, reconnect notices). */
export default defineEvent({
  name: Events.Warn,
  execute({ logger }, message) {
    logger.warn({ message }, 'Discord client warning');
  },
});
