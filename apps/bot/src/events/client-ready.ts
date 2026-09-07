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
        events: client.events.size,
        // Identity for the "is a second bot running on this token?" question.
        // Two "Bot is ready" lines with different ids means two processes.
        instanceId: client.instanceId,
        player: client.identity.label,
        pid: process.pid,
        // discord.js allows one listener set per client; more than one here
        // would mean the registry attached twice.
        interactionListeners: readyClient.listenerCount(Events.InteractionCreate),
      },
      'Bot is ready',
    );

    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: '/play', type: ActivityType.Listening }],
    });

    /**
     * 24/7 mode: rejoin voice channels and restore queues left by the last run.
     *
     * Primary only. Every client firing this would have the whole fleet race to
     * restore the same guild's single saved 24/7 room, and whichever lost would
     * find the channel already taken. Restoring across several rooms is the
     * router's job once it exists.
     */
    if (client.identity.role === 'primary' && client.music !== undefined) {
      client.music.restoreStayConnectedPlayers().catch((error: unknown) => {
        logger.warn({ err: error }, '24/7 restore failed');
      });
    }
  },
});
