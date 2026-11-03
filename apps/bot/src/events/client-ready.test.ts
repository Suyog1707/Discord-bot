/**
 * What every bot does once it is connected — in particular, picking the music
 * back up after a restart.
 *
 * Restoring used to be the primary's job alone (24/7 rooms only). Each bot now
 * rejoins the rooms *it* was playing in, so a player must restore too; only
 * the 24/7 pass, which waits in a channel rather than playing, stays with the
 * primary.
 */
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { BotClient } from '../core/bot-client.js';
import type { Logger } from '../lib/logger.js';

import clientReady from './client-ready.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function clientAs(
  role: 'primary' | 'player',
  restore: () => Promise<void> = () => Promise.resolve(),
) {
  const restoreAfterRestart = vi.fn(restore);
  const client = {
    identity: { label: role === 'primary' ? 'main' : 'player-2', role, clientId: 'app' },
    instanceId: 'instance',
    commands: { size: 0 },
    events: { size: 0 },
    services: {
      guilds: {
        registerBot: vi.fn(() => Promise.resolve()),
        syncBotPresence: vi.fn(() => Promise.resolve()),
      },
    },
    peers: undefined,
    music: { restoreAfterRestart },
  } as unknown as BotClient;
  return { client, restoreAfterRestart };
}

function readyClient(): Client<true> {
  return {
    user: { tag: 'bot#0001', id: 'bot', setPresence: vi.fn() },
    guilds: { cache: new Map([['111111111111111111', {}]]) },
    listenerCount: () => 1,
  } as unknown as Client<true>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('client ready: restoring after a restart', () => {
  it('a player bot restores its own playing rooms, without the 24/7 pass', async () => {
    const { client, restoreAfterRestart } = clientAs('player');

    await clientReady.execute({ client, logger }, readyClient());
    await settle();

    expect(restoreAfterRestart).toHaveBeenCalledTimes(1);
    expect(restoreAfterRestart).toHaveBeenCalledWith({ stayConnected: false });
  });

  it('the primary restores its playing rooms and runs the 24/7 pass', async () => {
    const { client, restoreAfterRestart } = clientAs('primary');

    await clientReady.execute({ client, logger }, readyClient());
    await settle();

    expect(restoreAfterRestart).toHaveBeenCalledWith({ stayConnected: true });
  });

  it('a failed restore is logged, never thrown', async () => {
    const { client } = clientAs('player', () => Promise.reject(new Error('lavalink down')));

    await expect(clientReady.execute({ client, logger }, readyClient())).resolves.toBeUndefined();
    await settle();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('does nothing about music on a bot without an audio server', async () => {
    const { client } = clientAs('player');
    (client as { music: unknown }).music = undefined;

    await expect(clientReady.execute({ client, logger }, readyClient())).resolves.toBeUndefined();
  });
});
