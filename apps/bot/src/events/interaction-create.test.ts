/**
 * The front door, by role.
 *
 * Only the primary routes what arrives on its gateway — it is the application
 * Discord delivers commands to once the Interactions Endpoint URL is cleared.
 * A player never receives a slash command over its own socket, and whatever
 * it does receive (its own controller's buttons) must behave exactly as it
 * did before the primary learned to route.
 */
import type { Interaction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotClient } from '../core/bot-client.js';
import { dispatchChatInputCommand } from '../core/dispatch-command.js';
import { dispatchMusicComponent } from '../core/dispatch-component.js';
import { routeGatewayCommand, routeGatewayComponent } from '../core/gateway-router.js';
import type { Logger } from '../lib/logger.js';

import interactionCreate from './interaction-create.js';

vi.mock('../core/dispatch-command.js', () => ({
  dispatchChatInputCommand: vi.fn(() => Promise.resolve()),
}));
vi.mock('../core/dispatch-component.js', () => ({
  dispatchMusicComponent: vi.fn(() => Promise.resolve()),
  isMusicComponent: vi.fn(() => true),
}));
vi.mock('../core/gateway-router.js', () => ({
  routeGatewayCommand: vi.fn(() => Promise.resolve()),
  routeGatewayComponent: vi.fn(() => Promise.resolve(false)),
}));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function clientAs(role: 'primary' | 'player'): BotClient {
  return {
    identity: { label: role === 'primary' ? 'main' : 'player-2', role },
    commands: { get: vi.fn() },
  } as unknown as BotClient;
}

function command(): Interaction {
  return {
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isChatInputCommand: () => true,
  } as unknown as Interaction;
}

function component(): Interaction {
  return {
    isAutocomplete: () => false,
    isMessageComponent: () => true,
    isChatInputCommand: () => false,
    customId: 'music:pause',
  } as unknown as Interaction;
}

async function deliver(client: BotClient, interaction: Interaction): Promise<void> {
  await interactionCreate.execute({ client, logger }, interaction);
}

beforeEach(() => {
  vi.mocked(dispatchChatInputCommand).mockClear();
  vi.mocked(dispatchMusicComponent).mockClear();
  vi.mocked(routeGatewayCommand).mockClear();
  vi.mocked(routeGatewayComponent).mockClear().mockResolvedValue(false);
});

describe('interactionCreate', () => {
  it('routes a slash command on the primary', async () => {
    const client = clientAs('primary');
    const interaction = command();

    await deliver(client, interaction);

    expect(routeGatewayCommand).toHaveBeenCalledWith(client, interaction, logger);
    expect(dispatchChatInputCommand).not.toHaveBeenCalled();
  });

  it('runs a slash command locally on a player, exactly as before', async () => {
    const client = clientAs('player');
    const interaction = command();

    await deliver(client, interaction);

    expect(dispatchChatInputCommand).toHaveBeenCalledWith(client, interaction, logger);
    expect(routeGatewayCommand).not.toHaveBeenCalled();
  });

  it('lets the primary hand a component to its owner before local handling', async () => {
    vi.mocked(routeGatewayComponent).mockResolvedValue(true);
    const client = clientAs('primary');

    await deliver(client, component());

    expect(routeGatewayComponent).toHaveBeenCalledTimes(1);
    expect(dispatchMusicComponent).not.toHaveBeenCalled();
  });

  it('handles a component locally on the primary when nobody else owns it', async () => {
    await deliver(clientAs('primary'), component());

    expect(routeGatewayComponent).toHaveBeenCalledTimes(1);
    expect(dispatchMusicComponent).toHaveBeenCalledTimes(1);
  });

  it('never asks the router about a component on a player', async () => {
    await deliver(clientAs('player'), component());

    expect(routeGatewayComponent).not.toHaveBeenCalled();
    expect(dispatchMusicComponent).toHaveBeenCalledTimes(1);
  });
});
