/**
 * Everything Discord delivers down this bot's own socket.
 *
 * A thin front door, and deliberately so. Autocomplete is answered here
 * because it cannot be deferred and so cannot be handed anywhere else;
 * commands and components go straight to the dispatchers they share with the
 * routed path, because a click has to behave the same whether it arrived here
 * or on a Redis queue.
 */
import { Events } from 'discord.js';

import { dispatchChatInputCommand } from '../core/dispatch-command.js';
import { dispatchMusicComponent, isMusicComponent } from '../core/dispatch-component.js';
import { defineEvent } from '../core/event.js';

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

    // The controller's buttons and filter menu. Shared with the routed path,
    // because the same click can arrive either way once an application's
    // interactions are delivered over HTTP instead of this socket.
    if (interaction.isMessageComponent() && isMusicComponent(interaction)) {
      await dispatchMusicComponent(client, interaction, logger);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Everything from here — the duplicate check, the acknowledgement, the
    // guards, the error handling — is shared with commands that arrive over
    // Redis from the router, because both have to behave identically.
    await dispatchChatInputCommand(client, interaction, logger);
  },
});
