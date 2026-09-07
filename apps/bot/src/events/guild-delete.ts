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
    if (client.identity.role !== 'primary') return;
    await client.services.guilds.markGuildLeft(guild.id);
  },
});
