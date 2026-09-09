import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/**
 * Bot removed from a guild. The row is retained (marked left) so settings and
 * playlists survive a re-invite.
 */
export default defineEvent({
  name: Events.GuildDelete,
  async execute({ client, logger }, guild) {
    // An unavailable guild is a Discord outage, not a removal.
    if (!guild.available) return;
    logger.info(
      { guildId: guild.id, name: guild.name, player: client.identity.label },
      'Left guild',
    );
    /**
     * Only the primary clears `isActive`. A player bot being kicked — or an
     * admin tidying up the member list — must not 404 the whole dashboard and
     * stop 24/7 restore for a server the primary is still happily playing in.
     */
    /**
     * Let go of any room here first.
     *
     * Being removed from a server is a disconnect the bot never asked for, and
     * without this the player object survives it — so the room state, the
     * index entry and the ownership claim all stay in Redis, the last of them
     * for hours. The router then keeps sending that channel's commands to a
     * bot that is not even in the guild, and they are dropped.
     *
     * `destroyPlayer` is the same teardown `/disconnect` runs, so the cleanup
     * is identical whichever way the bot leaves.
     */
    await client.music?.destroyPlayer(guild.id).catch((error: unknown) => {
      logger.warn({ err: error, guildId: guild.id }, 'Could not tear down the room on removal');
    });

    await client.services.guilds.setBotPresence(guild.id, client.identity.clientId, false);
    if (client.identity.role !== 'primary') return;
    await client.services.guilds.markGuildLeft(guild.id);
  },
});
