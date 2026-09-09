/**
 * The controller's buttons, on both roads in.
 *
 * These exist because the ordering changed: the handlers used to do the work
 * and acknowledge afterwards, which put a Lavalink round trip and a database
 * write inside Discord's three-second window. They acknowledge first now, and
 * that is also what lets a routed click work at all — by then the command
 * router has already answered on this bot's behalf.
 *
 * The vocabulary after a deferred update is the thing worth pinning: `editReply`
 * changes the message the button sits on, `followUp` speaks beside it. Getting
 * those the wrong way round replaces a controller everybody is looking at with
 * a private error, which is exactly the mistake the old code could not make and
 * this one could.
 */
import { GuildMember, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';
import { dispatchMusicComponent, isMusicComponent } from './dispatch-component.js';

const GUILD = '111111111111111111';
const VOICE = '222222222222222222';

function fakeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger;
}

function fakePlayer(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    voiceChannelId: VOICE,
    paused: false,
    volume: 100,
    autoplayEnabled: false,
    queue: {
      current: { title: 'Song', author: 'Artist', sourceKey: 'artist::song' },
      upcoming: [],
      loopMode: 'off',
    },
    skip: vi.fn(() => Promise.resolve(null)),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    setFilter: vi.fn(() => Promise.resolve()),
    setVolume: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function fakeClient(player: unknown): BotClient {
  return {
    music: { getPlayer: () => player, applyDislike: vi.fn() },
    services: {
      favorites: { add: vi.fn(() => Promise.resolve(true)) },
      dislikes: { add: vi.fn(() => Promise.resolve(true)) },
    },
  } as unknown as BotClient;
}

/**
 * A member the voice guard will actually accept.
 *
 * `sharesVoiceChannel` checks `instanceof GuildMember` — deliberately, because
 * a routed interaction whose guild is uncached degrades to a raw API object
 * with no voice state, and treating that as "in the room" would let anybody
 * drive a player they cannot see. A plain object can never satisfy it, so the
 * fake borrows the real prototype and shadows the `voice` getter.
 */
function memberIn(voiceChannelId: string | null): GuildMember {
  const member = Object.create(GuildMember.prototype) as GuildMember;
  Object.defineProperty(member, 'voice', { value: { channelId: voiceChannelId } });
  return member;
}

/** A click, in whichever state the road it came in on leaves it. */
function fakeButton(
  customId: string,
  options: { deferred?: boolean; inVoice?: string | null } = {},
) {
  const interaction = {
    customId,
    guildId: GUILD,
    deferred: options.deferred ?? false,
    replied: false,
    user: { id: '333333333333333333', username: 'listener' },
    // Nobody, until a test says otherwise — which is how the guard reads an
    // interaction whose member could not be resolved.
    member: null as unknown,
    message: { flags: { has: () => false } },
    isStringSelectMenu: () => false,
    isButton: () => true,
    deferUpdate: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  };
  return interaction;
}

describe('isMusicComponent', () => {
  it('claims the controller’s own components and nothing else', () => {
    expect(
      isMusicComponent({
        isStringSelectMenu: () => false,
        isButton: () => true,
        customId: 'music:skip',
      } as never),
    ).toBe(true);
    expect(
      isMusicComponent({
        isStringSelectMenu: () => true,
        customId: 'music:filter-select',
      } as never),
    ).toBe(true);
    // `/spotify`'s pagination is a collector's business, not this dispatcher's.
    expect(
      isMusicComponent({
        isStringSelectMenu: () => false,
        isButton: () => true,
        customId: 'spl:next#main',
      } as never),
    ).toBe(false);
  });
});

describe('dispatchMusicComponent', () => {
  it('acknowledges before touching the player', async () => {
    // The regression this ordering exists for: the skip used to happen first,
    // inside the three-second window.
    const order: string[] = [];
    const player = fakePlayer({
      skip: vi.fn(() => {
        order.push('skip');
        return Promise.resolve(null);
      }),
    });
    const interaction = fakeButton('music:skip');
    interaction.deferUpdate = vi.fn(() => {
      order.push('ack');
      return Promise.resolve();
    });
    // Standing in the room, so the transport guard lets it through.
    interaction.member = memberIn(VOICE);

    await dispatchMusicComponent(fakeClient(player), interaction as never, fakeLogger());

    expect(order[0]).toBe('ack');
  });

  it('does not acknowledge twice when the router already did', async () => {
    const interaction = fakeButton('music:skip', { deferred: true });
    interaction.member = memberIn(VOICE);

    await dispatchMusicComponent(fakeClient(fakePlayer()), interaction as never, fakeLogger());

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it('replaces the message when there is nothing playing', async () => {
    const interaction = fakeButton('music:skip');

    await dispatchMusicComponent(fakeClient(undefined), interaction as never, fakeLogger());

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Nothing is playing.',
      embeds: [],
      components: [],
    });
  });

  it('speaks beside the message when the clicker is elsewhere', async () => {
    // Never `editReply` here: the controller is a long-lived message other
    // people are looking at, and this must not replace it.
    const interaction = fakeButton('music:skip');

    await dispatchMusicComponent(fakeClient(fakePlayer()), interaction as never, fakeLogger());

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'Join my voice channel to control playback.',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('leaves the controller alone after a transport action', async () => {
    // The persistent controller re-renders from player events, so the click
    // needed only the acknowledgement.
    const player = fakePlayer();
    const interaction = fakeButton('music:skip');
    interaction.member = memberIn(VOICE);

    await dispatchMusicComponent(fakeClient(player), interaction as never, fakeLogger());

    expect(player.skip).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('answers an informational button beside the message', async () => {
    const interaction = fakeButton('music:favorite');
    interaction.member = memberIn(VOICE);

    await dispatchMusicComponent(fakeClient(fakePlayer()), interaction as never, fakeLogger());

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('reports a failure beside the message, never over it', async () => {
    const player = fakePlayer({
      skip: vi.fn(() => Promise.reject(new Error('lavalink is having a day'))),
    });
    const interaction = fakeButton('music:skip');
    interaction.member = memberIn(VOICE);

    await dispatchMusicComponent(fakeClient(player), interaction as never, fakeLogger());

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'That control failed. Try again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('gives up quietly when the interaction is already dead', async () => {
    // Nothing to answer on. The alternative is turning one 10062 into two.
    const interaction = fakeButton('music:skip');
    interaction.deferUpdate = vi.fn(() => Promise.reject(new Error('Unknown interaction')));
    const player = fakePlayer();

    await dispatchMusicComponent(fakeClient(player), interaction as never, fakeLogger());

    expect(player.skip).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
