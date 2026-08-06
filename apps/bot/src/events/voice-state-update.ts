import { Events } from 'discord.js';

import { defineEvent } from '../core/event.js';

/**
 * Voice-state housekeeping for the music engine:
 * - Bot force-disconnected (kicked from voice) → tear the player down.
 * - Bot moved to another channel → rebind the player's channel.
 * - Channel occupancy changes → start/stop the idle-leave timer.
 */
export default defineEvent({
  name: Events.VoiceStateUpdate,
  async execute({ client, logger }, _oldState, newState) {
    const music = client.music;
    if (music === undefined) return;

    const guildId = newState.guild.id;
    const player = music.getPlayer(guildId);
    if (player === undefined) return;

    const botId = client.user?.id;
    if (botId === undefined) return;

    // The bot's own state changed.
    if (newState.id === botId) {
      if (newState.channelId === null) {
        logger.info({ guildId }, 'Bot was disconnected from voice; destroying player');
        await music.destroyPlayer(guildId);
        return;
      }
      if (newState.channelId !== player.voiceChannelId) {
        logger.info(
          { guildId, from: player.voiceChannelId, to: newState.channelId },
          'Bot moved to another voice channel',
        );
        player.voiceChannelId = newState.channelId;
      }
    }

    // Occupancy: does the player's channel still contain a non-bot listener?
    const channel = newState.guild.channels.cache.get(player.voiceChannelId);
    if (channel?.isVoiceBased() === true) {
      const listeners = channel.members.filter((member) => !member.user.bot).size;
      player.onOccupancyChange(listeners > 0);
    }
  },
});
