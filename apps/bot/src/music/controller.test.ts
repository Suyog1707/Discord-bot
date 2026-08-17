import type { PlayerSnapshot } from '@discord-music/shared';
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { ControllerMessage } from './controller.js';

/** A few macrotask turns, enough for the controller's apply chain to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface FakeMessage {
  id: string;
  channel: FakeChannel;
  guildId: string;
  inGuild: () => boolean;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface FakeChannel {
  id: string;
  lastMessageId: string | null;
  isSendable: () => boolean;
  send: ReturnType<typeof vi.fn>;
  messages: FakeMessage[];
}

let messageCounter = 0;

function fakeChannel(id: string, guildId = 'guild-1'): FakeChannel {
  const channel: FakeChannel = {
    id,
    lastMessageId: null,
    isSendable: () => true,
    messages: [],
    send: vi.fn(),
  };
  channel.send.mockImplementation(() => {
    messageCounter += 1;
    const message: FakeMessage = {
      id: `msg-${String(messageCounter)}`,
      channel,
      guildId,
      inGuild: () => true,
      edit: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    channel.lastMessageId = message.id;
    channel.messages.push(message);
    return Promise.resolve(message);
  });
  return channel;
}

function fakeClient(channel: FakeChannel): Client {
  return {
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  } as unknown as Client;
}

function snapshot(title: string): PlayerSnapshot {
  return {
    current: {
      identifier: `id-${title}`,
      title,
      author: 'Artist',
      durationMs: 200_000,
      uri: `https://open.spotify.com/track/${title}`,
      artworkUrl: null,
      isStream: false,
      source: 'spotify',
      requestedByName: 'Tester',
    },
    positionMs: 0,
    paused: false,
    volume: 100,
    loopMode: 'off',
    autoplayEnabled: false,
    stayConnected: false,
    activeFilter: null,
    voiceChannelId: 'voice-1',
    upcoming: [],
    upcomingTotal: 0,
  };
}

describe('ControllerMessage', () => {
  it('sends one complete GUI on the first track', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(1);
    // Complete GUI: the full embed plus every control row (transport, extras,
    // volume, filter select — four rows).
    const payload = channel.send.mock.calls[0]?.[0] as {
      embeds: unknown[];
      components: unknown[];
    };
    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toHaveLength(4);
    await controller.destroy();
  });

  it('edits the tracked GUI while it is still the latest message', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();
    controller.onEvent('TRACK_START', snapshot('Song B'));
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.messages[0]?.edit.mock.calls.length).toBeGreaterThan(0);
    await controller.destroy();
  });

  it('sends a new GUI instead of editing one the conversation moved past', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();
    const gui = channel.messages[0];
    expect(gui).toBeDefined();
    const editsBefore = gui?.edit.mock.calls.length ?? 0;

    // Someone else speaks — the tracked GUI is no longer the latest message.
    channel.lastMessageId = 'user-message-1';

    controller.onEvent('TRACK_START', snapshot('Song C'));
    await settle();

    // The old GUI was never edited again; a fresh complete GUI was sent.
    expect(gui?.edit.mock.calls.length).toBe(editsBefore);
    expect(gui?.delete).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(2);
    await controller.destroy();
  });

  it('keeps editing the same GUI for non-start events even after other messages', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();
    channel.lastMessageId = 'user-message-1';

    // Pause/volume changes live-update the existing panel; only a NEW SONG
    // relocates the GUI.
    controller.onEvent('TRACK_PAUSE', { ...snapshot('Song A'), paused: true });
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(1);
    await controller.destroy();
  });

  it('recreates the GUI when the tracked message was deleted', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();
    const gui = channel.messages[0];
    gui?.edit.mockRejectedValue(new Error('Unknown Message'));

    controller.onEvent('TRACK_START', snapshot('Song B'));
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(2);
    await controller.destroy();
  });

  it('does not duplicate GUIs under rapid song changes', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    // Three starts land back-to-back, before any apply completes.
    controller.onEvent('TRACK_START', snapshot('Song A'));
    controller.onEvent('TRACK_START', snapshot('Song B'));
    controller.onEvent('TRACK_START', snapshot('Song C'));
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(1);
    await controller.destroy();
  });

  it('treats a message from another channel as stale', async () => {
    const channel = fakeChannel('chan-1');
    const controller = new ControllerMessage(fakeClient(channel), 'guild-1', 'chan-1');

    controller.onEvent('TRACK_START', snapshot('Song A'));
    await settle();
    const gui = channel.messages[0];
    expect(gui).toBeDefined();
    if (gui !== undefined) {
      // Simulate a reference gone stale across channels.
      gui.channel = { ...channel, id: 'other-channel' };
    }

    controller.onEvent('TRACK_START', snapshot('Song B'));
    await settle();

    expect(channel.send).toHaveBeenCalledTimes(2);
    await controller.destroy();
  });
});
