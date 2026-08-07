import { ActivityType, Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/** Fires once the gateway connection is established and the cache is populated. */
export default defineEvent({
  name: Events.ClientReady,
  once: true,
  execute({ client, logger }, readyClient) {
    logger.info(
      {
        tag: readyClient.user.tag,
        userId: readyClient.user.id,
        guilds: readyClient.guilds.cache.size,
        commands: client.commands.size,
      },
      'Bot is ready',
    );

    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: '/play', type: ActivityType.Listening }],
    });

    // 24/7 mode: rejoin voice channels and restore queues left by the last run.
    if (client.music !== undefined) {
      client.music.restoreStayConnectedPlayers().catch((error: unknown) => {
        logger.warn({ err: error }, '24/7 restore failed');
      });
    }
  },
});
