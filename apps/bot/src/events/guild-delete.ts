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
    logger.info({ guildId: guild.id, name: guild.name }, 'Left guild');
    await client.services.guilds.markGuildLeft(guild.id);
  },
});
