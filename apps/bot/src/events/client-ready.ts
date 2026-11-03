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

    // The roster the dashboard offers invites from. Fire-and-forget: a player
    // that cannot write it still plays.
    void client.services.guilds
      .registerBot({
        clientId: client.identity.clientId,
        label: client.identity.label,
        role: client.identity.role,
      })
      // Presence for the servers this player was ALREADY in. `guildCreate`
      // only fires on a fresh join, so without this a long-standing server
      // would show every player as "not added" and offer invites for bots
      // sitting in it.
      .then(async () =>
        client.services.guilds.syncBotPresence(client.identity.clientId, [
          ...readyClient.guilds.cache.keys(),
        ]),
      )
      .catch(() => undefined);

    // The same list for the command router, which reads it on every command
    // instead of asking Postgres — straight from the gateway cache.
    void client.peers?.indexGuilds([...readyClient.guilds.cache.keys()]);

    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: '/play', type: ActivityType.Listening }],
    });

    /**
     * Pick the music back up after a restart.
     *
     * Every bot restores the rooms it was itself playing in — rejoining and
     * continuing at about the saved position — so players run this too. Only
     * the 24/7 pass, which waits in a channel rather than playing, stays with
     * the primary: every client running it would have the fleet race for the
     * same guild's single saved 24/7 room.
     */
    if (client.music !== undefined) {
      client.music
        .restoreAfterRestart({ stayConnected: client.identity.role === 'primary' })
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'Restart restore failed');
        });
    }

    // Everything above is fire-and-forget; nothing here is waited on.
    return Promise.resolve();
  },
});
