/**
 * Proof that a command can run from raw JSON, with no gateway and no network.
 *
 * The last test in this file is the important one. Everything about routing
 * rests on discord.js taking `application_id` from the payload rather than
 * from the client — if a version bump ever changed that, every routed reply
 * would 404 in production and nothing else here would notice.
 */
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  Client,
  InteractionType,
  PermissionFlagsBits,
  type APIChatInputApplicationCommandInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { rehydrateChatInputInteraction } from './interaction-rehydrate.js';

const APPLICATION_ID = '111111111111111111';
const INTERACTION_ID = '222222222222222222';
const GUILD_ID = '333333333333333333';
const CHANNEL_ID = '444444444444444444';
const USER_ID = '555555555555555555';
const TOKEN = 'an-interaction-token';

/**
 * A client that never connects.
 *
 * `new Client()` builds every manager without opening a socket, which is all
 * rehydration needs — and `entitlements: []` on the payload keeps the
 * constructor from reaching for `client.application`, which is null until
 * ready.
 */
function offlineClient(): Client<true> {
  return new Client({ intents: [] });
}

function payload(
  overrides: Partial<APIChatInputApplicationCommandInteraction> = {},
): APIChatInputApplicationCommandInteraction {
  return {
    id: INTERACTION_ID,
    application_id: APPLICATION_ID,
    type: InteractionType.ApplicationCommand,
    token: TOKEN,
    version: 1,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: { id: CHANNEL_ID, type: 0 },
    app_permissions: '8',
    entitlements: [],
    authorizing_integration_owners: {},
    locale: 'en-GB',
    member: {
      user: {
        id: USER_ID,
        username: 'listener',
        discriminator: '0',
        avatar: null,
        global_name: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
      permissions: String(PermissionFlagsBits.ManageGuild),
    },
    data: {
      id: '1',
      name: 'remove',
      type: ApplicationCommandType.ChatInput,
      options: [{ name: 'position', type: ApplicationCommandOptionType.Integer, value: 3 }],
    },
    ...overrides,
  } as APIChatInputApplicationCommandInteraction;
}

describe('rehydrateChatInputInteraction', () => {
  it('rebuilds the command and its options', () => {
    const interaction = rehydrateChatInputInteraction(offlineClient(), payload(), 'ephemeral');

    expect(interaction.commandName).toBe('remove');
    expect(interaction.options.getInteger('position', true)).toBe(3);
    expect(interaction.user.id).toBe(USER_ID);
    expect(interaction.guildId).toBe(GUILD_ID);
    expect(interaction.channelId).toBe(CHANNEL_ID);
  });

  it('carries the permissions Discord already resolved for the channel', () => {
    // Better than anything the bot could compute locally, and what the
    // `botPermissions` guard reads.
    const interaction = rehydrateChatInputInteraction(offlineClient(), payload(), 'ephemeral');

    expect(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)).toBe(true);
  });

  it('unwraps a subcommand group', () => {
    const interaction = rehydrateChatInputInteraction(
      offlineClient(),
      payload({
        data: {
          id: '1',
          name: 'playlist',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'manage',
              type: ApplicationCommandOptionType.SubcommandGroup,
              options: [{ name: 'rename', type: ApplicationCommandOptionType.Subcommand }],
            },
          ],
        },
      }),
      'ephemeral',
    );

    expect(interaction.options.getSubcommandGroup()).toBe('manage');
    expect(interaction.options.getSubcommand()).toBe('rename');
  });

  it('reflects the acknowledgement the router already sent', () => {
    const ephemeral = rehydrateChatInputInteraction(offlineClient(), payload(), 'ephemeral');
    expect(ephemeral.deferred).toBe(true);
    expect(ephemeral.replied).toBe(false);
    expect(ephemeral.ephemeral).toBe(true);

    const publicly = rehydrateChatInputInteraction(offlineClient(), payload(), 'public');
    expect(publicly.ephemeral).toBe(false);
  });

  /**
   * The canary.
   *
   * A routed command is answered by a bot whose own application id is NOT the
   * one that owns the interaction. This asserts the reply goes to the payload's
   * application — the single fact the whole design rests on.
   */
  it('replies under the application that owns the interaction, not the bot', async () => {
    const client = offlineClient();
    const patch = vi
      .spyOn(client.rest, 'patch')
      .mockResolvedValue({ id: '1', channel_id: CHANNEL_ID });

    const interaction = rehydrateChatInputInteraction(client, payload(), 'ephemeral');
    await interaction.editReply({ content: 'done' });

    expect(patch).toHaveBeenCalledTimes(1);
    const [route, options] = patch.mock.calls[0] ?? [];

    // `@original` arrives percent-encoded; the id in front of it is the point.
    // This client has no application of its own — it never logged in — so the
    // only place that id can have come from is the payload.
    expect(route).toBe(`/webhooks/${APPLICATION_ID}/${TOKEN}/messages/%40original`);
    // Authorised by the interaction token in the path; sending a bot token
    // here would be the mistake, not the omission.
    expect(options).toMatchObject({ auth: false });
  });
});
