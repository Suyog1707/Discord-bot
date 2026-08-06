/**
 * Central interaction dispatcher.
 *
 * All slash-command error handling lives here so individual commands can throw
 * freely and stay focused on their own logic. Covers routing, guard
 * enforcement (guild-only, permissions, cooldowns, DJ role), unknown-command
 * handling and safe error replies.
 */
import { AppError, toAppError } from '@discord-music/shared';
import { Events, MessageFlags, type Interaction } from 'discord.js';

import { defineEvent } from '../core/event.js';
import { runGuards } from '../core/guards.js';

/**
 * Reply with an error, choosing the correct method for the interaction's state.
 *
 * Once an interaction has been replied to or deferred, `reply()` throws
 * `InteractionAlreadyReplied`; this picks `followUp`/`editReply` accordingly.
 */
async function replyWithError(
  interaction: Extract<Interaction, { replied: boolean }>,
  message: string,
): Promise<void> {
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;

  if (interaction.deferred) {
    await interaction.editReply({ content: message });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

export default defineEvent({
  name: Events.InteractionCreate,
  async execute({ client, logger }, interaction) {
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;

      try {
        await command.autocomplete({
          interaction,
          logger: logger.child({ command: interaction.commandName }),
        });
      } catch (error) {
        // Autocomplete has a 3s budget; never block, just record the failure.
        logger.error({ err: error, command: interaction.commandName }, 'Autocomplete failed');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      // Usually a stale registration — the command was removed but not redeployed.
      logger.warn({ command: interaction.commandName }, 'Received unknown command');
      await replyWithError(interaction, 'That command is no longer available.');
      return;
    }

    const commandLogger = logger.child({
      command: interaction.commandName,
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
    });

    const startedAt = Date.now();

    // Guards cover guild-only, permissions, cooldowns and the DJ role.
    try {
      const guard = await runGuards(client, command, interaction);
      if (!guard.allowed) {
        await replyWithError(interaction, guard.message ?? 'You cannot use that right now.');
        return;
      }
    } catch (error) {
      // A guard that *errors* (e.g. settings lookup with the DB down) must not
      // dead-end the interaction with silence.
      commandLogger.error({ err: error }, 'Guard evaluation failed');
      await replyWithError(interaction, 'Something went wrong checking permissions. Try again.');
      return;
    }

    try {
      await command.execute({ interaction, logger: commandLogger });
      commandLogger.info({ durationMs: Date.now() - startedAt }, 'Command executed');
    } catch (error) {
      const appError = toAppError(error);

      // Expected failures (bad input, not found) are warnings, not incidents.
      const level = appError.expected ? 'warn' : 'error';
      commandLogger[level]({ err: appError, durationMs: Date.now() - startedAt }, 'Command failed');

      try {
        await replyWithError(
          interaction,
          appError instanceof AppError && appError.expected
            ? appError.message
            : 'Something went wrong while running that command. Please try again.',
        );
      } catch (replyError) {
        commandLogger.error({ err: replyError }, 'Failed to send error reply');
      }
    }
  },
});
