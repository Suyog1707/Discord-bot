import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/** Bot added to a guild (or guild came back online): register it. */
export default defineEvent({
  name: Events.GuildCreate,
  async execute({ client, logger }, guild) {
    logger.info(
      {
        guildId: guild.id,
        name: guild.name,
        members: guild.memberCount,
        player: client.identity.label,
      },
      'Joined guild',
    );
    /**
     * `Guild.isActive` means "this server has the bot", and the dashboard gates
     * all access on it. Only the primary may write it: a player bot joining is
     * not what makes a server set up, and a player joining a server the primary
     * is absent from would open the dashboard for a bot that cannot take a
     * command.
     */
    if (client.identity.role === 'primary') {
      await client.services.guilds.ensureGuild(guild);
    }
    // Every player records its own presence, primary included: "which players
    // does this server have?" is the question the invite prompt answers, and
    // only a row per player can answer it.
    await client.services.guilds.setBotPresence(guild.id, client.identity.clientId, true);
  },
});
