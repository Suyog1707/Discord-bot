import { GuildMember, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import pause from './pause.js';
import resume from './resume.js';
import stop from './stop.js';
import volume from './volume.js';
import seek, { parseTimestamp } from './seek.js';
import clear from '../queue/clear.js';
import shuffle from '../queue/shuffle.js';
import type { CommandDefinition } from '../../core/command.js';
import type { Logger } from '../../lib/logger.js';

function fixture(result: unknown = { kind: 'count', count: 3 }, option: number | string = 50) {
  const member = Object.create(GuildMember.prototype) as GuildMember;
  Object.defineProperty(member, 'voice', { value: { channelId: 'voice' } });
  const player = {
    queue: { current: { durationMs: 180000, isStream: false } },
    seekTo: vi.fn().mockResolvedValue(undefined),
  };
  const router = { runIntent: vi.fn().mockResolvedValue(result), playerFor: vi.fn(() => player) };
  const interaction = {
    client: { router },
    guildId: 'guild',
    channelId: 'text',
    member,
    user: { id: 'user' },
    inGuild: () => true,
    options: { getInteger: () => option, getString: () => option },
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return { interaction, router, player };
}
async function execute(command: CommandDefinition, interaction: unknown) {
  await command.execute({
    interaction: interaction as ChatInputCommandInteraction,
    logger: {} as Logger,
  });
}

describe('real playback command execution with simulated player transport', () => {
  it.each([pause, resume, stop, volume, clear, shuffle])(
    '/$data.name sends a room intent and confirms success',
    async (command) => {
      const { interaction, router } = fixture();
      await execute(command, interaction);
      expect(router.runIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: command.data.name,
          guildId: 'guild',
          voiceChannelId: 'voice',
          issuedBy: 'user',
        }),
      );
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
    },
  );
  it.each([pause, resume, stop, volume, clear, shuffle])(
    '/$data.name explains player refusal without a success reply',
    async (command) => {
      const { interaction } = fixture({
        kind: 'error',
        message: 'The audio server is unavailable.',
      });
      await execute(command, interaction);
      expect(interaction.editReply).toHaveBeenCalledExactlyOnceWith({
        content: 'The audio server is unavailable.',
      });
    },
  );
  it('rejects invalid volume before sending an intent', async () => {
    const { interaction, router } = fixture(undefined, -1);
    await expect(execute(volume, interaction)).rejects.toThrow();
    expect(router.runIntent).not.toHaveBeenCalled();
  });
  it('seeks to a valid position', async () => {
    const { interaction, player } = fixture(undefined, '1:30');
    await execute(seek, interaction);
    expect(player.seekTo).toHaveBeenCalledWith(90000);
  });
  it('rejects seeking past track end', async () => {
    const { interaction, player } = fixture(undefined, '4:00');
    await expect(execute(seek, interaction)).rejects.toThrow('past the end');
    expect(player.seekTo).not.toHaveBeenCalled();
  });
  it.each(['1:99', '1:60:00', '-1', 'NaN', '1:2:3:4', '999999999999999999999'])(
    'rejects invalid timestamp %s',
    (input) => {
      expect(parseTimestamp(input)).toBeNull();
    },
  );
});
