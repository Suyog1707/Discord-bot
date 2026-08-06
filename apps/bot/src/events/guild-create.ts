import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/** Bot added to a guild (or guild came back online): register it. */
export default defineEvent({
  name: Events.GuildCreate,
  async execute({ client, logger }, guild) {
    logger.info(
      { guildId: guild.id, name: guild.name, members: guild.memberCount },
      'Joined guild',
    );
    await client.services.guilds.ensureGuild(guild);
  },
});
