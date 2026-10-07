import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { withComponentOwner } from '@discord-music/shared';

import command from './spotify.js';

vi.mock('../../music/voice-context.js', () => ({
  requireMusic: (client: { music: unknown }) => client.music,
  requireRouter: (client: { router: unknown }) => client.router,
  requireVoiceContext: () => ({ guildId: 'guild', voiceChannelId: 'voice' }),
}));

async function browser() {
  const collector = new EventEmitter();
  const player = {
    queue: { tracks: [], capacity: 10, size: 0, upcoming: [{}, {}], currentIndex: 0 },
    enqueue: vi.fn((_tracks: unknown, _options: unknown) => Promise.resolve()),
    jumpTo: vi.fn((_index: number) => Promise.resolve()),
  };
  const tracks = [
    {
      title: 'Song',
      artist: 'Artist',
      spotifyId: 'track',
      durationMs: 200_000,
      spotifyUrl: 'https://open.spotify.com/track/track',
    },
  ];
  const client = {
    identity: { label: 'main' },
    logger: { error: vi.fn() },
    router: { joinRoom: vi.fn(() => Promise.resolve(player)) },
    music: {
      resolveSpotifyMetadata: vi.fn(
        async (
          metadata: unknown[],
          _requester: unknown,
          append: (resolved: unknown[]) => Promise<void>,
        ) => {
          if (metadata.length > 0) await append(metadata);
          return { resolvedTrackCount: metadata.length };
        },
      ),
    },
    services: {
      spotify: {
        isConfigured: () => true,
        canReadTokens: () => true,
        listPlaylists: () =>
          Promise.resolve(
            Array.from({ length: 12 }, (_, i) => ({
              spotifyId: `p${String(i)}`,
              name: `Playlist ${String(i)}`,
              owner: 'Owner',
              trackCount: 2,
            })),
          ),
        importItem: vi.fn(() =>
          Promise.resolve({ changed: true, name: 'Playlist 0', trackCount: 2 }),
        ),
        playlistTracks: vi.fn(() => Promise.resolve(tracks)),
      },
    },
  };
  const interaction = {
    client,
    user: { id: 'user' },
    options: { getSubcommand: () => 'playlists', getString: () => null },
    editReply: vi.fn(() => Promise.resolve({ createMessageComponentCollector: () => collector })),
  };
  await command.execute({ interaction } as never);
  async function click(id: string, deferred = true) {
    const component = {
      customId: withComponentOwner(id, 'main'),
      deferred,
      replied: false,
      values: ['p0'],
      isStringSelectMenu: () => id === 'spl:select',
      isButton: () => id !== 'spl:select',
      deferUpdate: vi.fn(() => {
        component.deferred = true;
        return Promise.resolve();
      }),
      editReply: vi.fn((_payload: unknown) => Promise.resolve(undefined)),
      followUp: vi.fn((_payload: unknown) => Promise.resolve(undefined)),
      update: vi.fn(() => {
        throw new Error('must not acknowledge twice');
      }),
    };
    collector.emit('collect', component);
    await vi.waitFor(() => {
      expect(
        component.editReply.mock.calls.length + component.followUp.mock.calls.length,
      ).toBeGreaterThan(0);
    });
    return component;
  }
  return { click, client, player };
}

describe('Spotify playlist components', () => {
  it('edits an already deferred dropdown without acknowledging it again', async () => {
    const { click } = await browser();
    const component = await click('spl:select');
    expect(component.deferUpdate).not.toHaveBeenCalled();
    expect(component.update).not.toHaveBeenCalled();
    expect(component.editReply).toHaveBeenCalledOnce();
  });
  it('acknowledges a gateway dropdown once before editing', async () => {
    const { click } = await browser();
    expect((await click('spl:select', false)).deferUpdate).toHaveBeenCalledOnce();
  });
  it('normalizes owner suffixes when moving to the next page', async () => {
    const { click } = await browser();
    const component = await click('spl:next');
    const payload = component.editReply.mock.calls[0]?.[0] as {
      embeds: { toJSON(): { footer: { text: string } } }[];
    };
    expect(payload.embeds[0]?.toJSON().footer.text).toContain('Page 2/2');
  });
  it('imports/syncs after deferral and labels owner-suffixed sync correctly', async () => {
    const { click, client } = await browser();
    await click('spl:select');
    const component = await click('spl:sync');
    expect(client.services.spotify.importItem).toHaveBeenCalledOnce();
    expect(component.deferUpdate).not.toHaveBeenCalled();
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Synced') }),
    );
  });
  it('plays an owner-tagged playlist and jumps to its newly queued tracks', async () => {
    const { click, player } = await browser();
    await click('spl:select');
    const component = await click('spl:play');
    expect(component.deferUpdate).not.toHaveBeenCalled();
    expect(player.enqueue).toHaveBeenCalledWith(expect.any(Array), { next: false });
    expect(player.jumpTo).toHaveBeenCalledOnce();
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Playing') }),
    );
  });
  it('queues without jumping away from current playback', async () => {
    const { click, player } = await browser();
    await click('spl:select');
    const component = await click('spl:queue');
    expect(player.enqueue).toHaveBeenCalledWith(expect.any(Array), {});
    expect(player.jumpTo).not.toHaveBeenCalled();
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Queued') }),
    );
  });
  it('does not resolve or enqueue tracks when the queue is full', async () => {
    const { click, player, client } = await browser();
    player.queue.size = player.queue.capacity;
    await click('spl:select');
    const component = await click('spl:queue');
    expect(player.enqueue).not.toHaveBeenCalled();
    expect(client.music.resolveSpotifyMetadata).toHaveBeenCalledWith(
      [],
      expect.anything(),
      expect.any(Function),
    );
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('over the queue limit') }),
    );
  });
  it('logs unexpected failures instead of hiding their cause', async () => {
    const { click, client } = await browser();
    client.services.spotify.importItem.mockRejectedValueOnce(new Error('database unavailable'));
    await click('spl:select');
    const component = await click('spl:import');
    expect(client.logger.error).toHaveBeenCalled();
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Spotify playlist action failed: An unexpected error'),
      }),
    );
  });
  it('explains an empty or unavailable playlist without enqueueing', async () => {
    const { click, client, player } = await browser();
    client.services.spotify.playlistTracks.mockResolvedValueOnce([]);
    await click('spl:select');
    const component = await click('spl:play');
    expect(player.enqueue).not.toHaveBeenCalled();
    expect(component.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('contains no available music tracks'),
      }),
    );
  });
});
