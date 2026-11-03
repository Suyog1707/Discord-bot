/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated -- these
   are spies being asserted on, never detached and called; the deprecation is
   discord.js's `fetchReply` overload, which neither the fakes nor the code use. */
/**
 * Routing on the primary's own gateway.
 *
 * With Discord's Interactions Endpoint URL cleared, every slash command
 * arrives here, on main's websocket, within milliseconds — instead of through
 * Vercel and a Funnel relay that measured 2.8–40 s and blew Discord's
 * three-second window. Main then has to do what the HTTP router did: say
 * "thinking…" at once, pick the bot for the caller's voice channel, and put
 * the command on that bot's queue — its own included, so there is one
 * execution path for a routed command whoever runs it.
 *
 * The properties pinned here are the ones that are invisible until they are
 * wrong in production:
 *
 *   - the acknowledgement goes out before any I/O at all;
 *   - the envelope carries the raw payload Discord sent, so the subscriber
 *     rehydrates exactly what it would from the HTTP router;
 *   - every failure ends in a message on the placeholder, never a spinner;
 *   - anything this cannot route runs locally, as it did before;
 *   - a player bot behaves exactly as it always has.
 */
import {
  buildFleet,
  decodeInteractionEnvelope,
  interactionAckKey,
  routeInteraction,
  type BotPresence,
  type FleetView,
  type RawInteraction,
} from '@discord-music/shared';
import { MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, MessageComponentInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';
import { dispatchChatInputCommand } from './dispatch-command.js';
import { FleetUnavailableError, type FleetSnapshot } from './gateway-fleet.js';
import {
  PICKUP_CHECKS_MS,
  routeGatewayCommand,
  routeGatewayComponent,
  type GatewayRouterDeps,
} from './gateway-router.js';
import { RawInteractionCache } from './raw-interactions.js';

vi.mock('./dispatch-command.js', () => ({
  dispatchChatInputCommand: vi.fn(() => Promise.resolve()),
}));

const GUILD = '111111111111111111';
const VOICE = '222222222222222222';
const OTHER_VOICE = '333333333333333333';
const USER = '444444444444444444';
const APP = '000000000000000001';
const NOW = 1_800_000_000_000;

const MAIN_CLIENT = '500000000000000001';
const P2_CLIENT = '500000000000000002';
const P4_CLIENT = '500000000000000004';

/** Everything that happened, in order, so "before" can be asserted. */
let order: string[];

beforeEach(() => {
  order = [];
  vi.mocked(dispatchChatInputCommand).mockClear();
});

function fakeLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger & { info: ReturnType<typeof vi.fn> };
}

function presence(
  botId: string,
  clientId: string,
  role: 'primary' | 'player',
  servingIn: string | null = null,
): BotPresence {
  return {
    botId,
    clientId,
    role,
    sentAt: NOW,
    rooms:
      servingIn === null
        ? []
        : [
            {
              guildId: GUILD,
              voiceChannelId: servingIn,
              isPlaying: true,
              hasListeners: true,
              stayConnected: false,
              emptySince: null,
            },
          ],
  };
}

function fleetOf(
  live: readonly BotPresence[],
  extraRoster: readonly { botId: string; clientId: string }[] = [],
  invited: readonly string[] = live.map((entry) => entry.clientId),
): FleetView {
  return buildFleet({
    roster: [...live.map(({ botId, clientId }) => ({ botId, clientId })), ...extraRoster],
    invited: new Set(invited),
    presence: live,
    claims: new Map(),
    guildId: GUILD,
    now: NOW,
    staleAfterMs: 45_000,
  });
}

function snapshot(live: readonly BotPresence[], ownerBotId: string | null = null): FleetSnapshot {
  return { fleet: fleetOf(live), ownerBotId, presence: live };
}

/** main idle, player-2 idle: a /play in VOICE would allocate main. */
const IDLE_FLEET = [
  presence('main', MAIN_CLIENT, 'primary'),
  presence('player-2', P2_CLIENT, 'player'),
];

/** player-2 already in the caller's channel and named by the owner claim. */
const OWNED_FLEET = [
  presence('main', MAIN_CLIENT, 'primary', OTHER_VOICE),
  presence('player-2', P2_CLIENT, 'player', VOICE),
];

/** Every bot busy elsewhere with people listening: nothing to allocate. */
const FULL_FLEET = [presence('main', MAIN_CLIENT, 'primary', OTHER_VOICE)];

function fakeRedis(ack: string | null = 'player-2') {
  return {
    status: 'ready',
    get: vi.fn((key: string) => {
      order.push(`redis.get:${key}`);
      return Promise.resolve(ack);
    }),
  };
}

function deps(overrides: Partial<GatewayRouterDeps> = {}): GatewayRouterDeps {
  return {
    readFleet: vi.fn(() => {
      order.push('readFleet');
      return Promise.resolve(snapshot(IDLE_FLEET));
    }),
    fleetFromDatabase: vi.fn((_guildId: string, live: readonly BotPresence[]) => {
      order.push('fleetFromDatabase');
      return Promise.resolve(fleetOf(live));
    }),
    readBotIds: vi.fn(() => {
      order.push('readBotIds');
      return Promise.resolve(['main', 'player-2', 'player-3']);
    }),
    claimAndHandOver: vi.fn(() => {
      order.push('claimAndHandOver');
      return Promise.resolve({ kind: 'won' as const });
    }),
    handOver: vi.fn(() => {
      order.push('handOver');
      return Promise.resolve();
    }),
    reclaimGraceMs: 60_000,
    sleep: vi.fn(() => Promise.resolve()),
    now: () => NOW,
    ...overrides,
  };
}

function rawCommand(id = 'int-1'): RawInteraction {
  return {
    id,
    application_id: APP,
    token: `token-${id}`,
    type: 2,
    guild_id: GUILD,
    channel_id: '666666666666666666',
    member: { user: { id: USER } },
    data: { id: 'cmd', name: 'play', type: 1 },
  };
}

interface ClientOptions {
  readonly role?: 'primary' | 'player';
  readonly redis?: ReturnType<typeof fakeRedis> | undefined;
  readonly raw?: RawInteraction | undefined;
  readonly commands?: Record<string, { deferral?: unknown }>;
  /** Whether main's own queue is being read. Defaults to true. */
  readonly subscriberRunning?: boolean;
}

function fakeClient(options: ClientOptions = {}): BotClient {
  const raw = new RawInteractionCache({ now: () => NOW });
  const payload = 'raw' in options ? options.raw : rawCommand();
  if (payload !== undefined) raw.capture({ t: 'INTERACTION_CREATE', d: payload });

  const commands = options.commands ?? { play: { deferral: 'public' } };
  return {
    identity: {
      label: options.role === 'player' ? 'player-2' : 'main',
      clientId: MAIN_CLIENT,
      role: options.role ?? 'primary',
      token: 't',
    },
    commands: { get: (name: string) => commands[name] },
    redis: 'redis' in options ? options.redis : fakeRedis(),
    rawInteractions: raw,
    interactionSubscriberRunning: options.subscriberRunning ?? true,
  } as unknown as BotClient;
}

interface FakeCommandInteraction {
  id: string;
  commandName: string;
  guildId: string | null;
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;
  user: { id: string };
  guild: unknown;
  options: { getSubcommand: () => string | null };
  inGuild: () => boolean;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
}

function fakeCommand(
  options: { voiceChannelId?: string | null; guildId?: string | null; id?: string } = {},
): FakeCommandInteraction & ChatInputCommandInteraction {
  const voice = 'voiceChannelId' in options ? options.voiceChannelId : VOICE;
  const guildId = 'guildId' in options ? (options.guildId ?? null) : GUILD;
  const interaction: FakeCommandInteraction = {
    id: options.id ?? 'int-1',
    commandName: 'play',
    guildId,
    createdTimestamp: NOW - 50,
    deferred: false,
    replied: false,
    user: { id: USER },
    guild:
      guildId === null
        ? null
        : {
            id: guildId,
            voiceStates: {
              cache: new Map(voice === null ? [] : [[USER, { channelId: voice }]]),
            },
          },
    options: { getSubcommand: () => null },
    inGuild: () => guildId !== null,
    deferReply: vi.fn(() => {
      order.push('ack');
      interaction.deferred = true;
      return Promise.resolve();
    }),
    editReply: vi.fn(() => {
      order.push('editReply');
      return Promise.resolve();
    }),
  };
  return interaction as unknown as FakeCommandInteraction & ChatInputCommandInteraction;
}

function envelopeHandedTo(router: GatewayRouterDeps, kind: 'handOver' | 'claimAndHandOver') {
  if (kind === 'handOver') {
    const [, botId, envelope] = vi.mocked(router.handOver).mock.calls[0] ?? [];
    return { botId, envelope: decodeInteractionEnvelope(String(envelope)) };
  }
  const [, input] = vi.mocked(router.claimAndHandOver).mock.calls[0] ?? [];
  return { botId: input?.botId, envelope: decodeInteractionEnvelope(String(input?.envelope)) };
}

describe('routeGatewayCommand', () => {
  it("runs locally, and pushes nothing, when main's own subscriber is not running", async () => {
    const router = deps();
    const interaction = fakeCommand();
    const logger = fakeLogger();
    const client = fakeClient({ subscriberRunning: false });

    await routeGatewayCommand(client, interaction, logger, router);

    expect(dispatchChatInputCommand).toHaveBeenCalledWith(client, interaction, logger);
    expect(router.readFleet).not.toHaveBeenCalled();
    expect(router.claimAndHandOver).not.toHaveBeenCalled();
    expect(router.handOver).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'subscriber-not-running' }),
      expect.any(String),
    );
  });

  it('routes as usual when the subscriber is running', async () => {
    const router = deps();
    await routeGatewayCommand(
      fakeClient({ subscriberRunning: true }),
      fakeCommand(),
      fakeLogger(),
      router,
    );
    expect(dispatchChatInputCommand).not.toHaveBeenCalled();
    expect(router.claimAndHandOver).toHaveBeenCalledTimes(1);
  });

  it('acknowledges before it reads the fleet or touches Redis', async () => {
    const router = deps();
    const interaction = fakeCommand();

    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router);

    expect(order[0]).toBe('ack');
    expect(order.indexOf('ack')).toBeLessThan(order.indexOf('readFleet'));
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  });

  it('acknowledges with the visibility the command declared, and says so in the envelope', async () => {
    const router = deps({
      readFleet: vi.fn(() => Promise.resolve(snapshot(OWNED_FLEET, 'player-2'))),
    });
    const interaction = fakeCommand();

    await routeGatewayCommand(
      fakeClient({ commands: { play: { deferral: 'ephemeral' } } }),
      interaction,
      fakeLogger(),
      router,
    );

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(envelopeHandedTo(router, 'handOver').envelope?.deferral).toBe('ephemeral');
  });

  it("reads the caller's voice channel from main's own cache", async () => {
    const router = deps();
    await routeGatewayCommand(fakeClient(), fakeCommand(), fakeLogger(), router);
    expect(router.readFleet).toHaveBeenCalledWith(expect.anything(), GUILD, VOICE);
  });

  it('routes to the player that already owns the channel, with the raw payload', async () => {
    const router = deps({
      readFleet: vi.fn(() => Promise.resolve(snapshot(OWNED_FLEET, 'player-2'))),
    });
    const client = fakeClient();

    await routeGatewayCommand(client, fakeCommand(), fakeLogger(), router);

    expect(router.claimAndHandOver).not.toHaveBeenCalled();
    const { botId, envelope } = envelopeHandedTo(router, 'handOver');
    expect(botId).toBe('player-2');
    expect(envelope).toMatchObject({
      payload: rawCommand(),
      deferral: 'public',
      voiceChannelId: VOICE,
      routedAt: NOW,
    });
    expect(vi.mocked(router.handOver).mock.calls[0]?.[0]).toBe(client.redis);
    expect(dispatchChatInputCommand).not.toHaveBeenCalled();
  });

  it('routes to itself through its own queue, claiming the room, rather than running inline', async () => {
    const router = deps();

    await routeGatewayCommand(fakeClient(), fakeCommand(), fakeLogger(), router);

    expect(dispatchChatInputCommand).not.toHaveBeenCalled();
    expect(router.handOver).not.toHaveBeenCalled();
    const [, input] = vi.mocked(router.claimAndHandOver).mock.calls[0] ?? [];
    expect(input).toMatchObject({ botId: 'main', guildId: GUILD, voiceChannelId: VOICE });
    expect(envelopeHandedTo(router, 'claimAndHandOver').envelope?.payload).toEqual(rawCommand());
  });

  it('sends a command typed outside voice to the primary with no room', async () => {
    const router = deps();

    await routeGatewayCommand(
      fakeClient(),
      fakeCommand({ voiceChannelId: null }),
      fakeLogger(),
      router,
    );

    expect(router.readFleet).toHaveBeenCalledWith(expect.anything(), GUILD, null);
    const { botId, envelope } = envelopeHandedTo(router, 'handOver');
    expect(botId).toBe('main');
    expect(envelope?.voiceChannelId).toBeNull();
  });

  it('logs the route with via: gateway and its timing', async () => {
    const logger = fakeLogger();
    await routeGatewayCommand(fakeClient(), fakeCommand(), logger, deps());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        via: 'gateway',
        botId: 'main',
        guildId: GUILD,
        voiceChannelId: VOICE,
        reason: 'free',
      }),
      'Command routed',
    );
  });

  it('answers a refusal on the placeholder, after a second look at the full roster', async () => {
    const router = deps({ readFleet: vi.fn(() => Promise.resolve(snapshot(FULL_FLEET))) });
    const interaction = fakeCommand();

    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router);

    const expected = routeInteraction({
      guildId: GUILD,
      voiceChannelId: VOICE,
      ownerBotId: null,
      fleet: fleetOf(FULL_FLEET),
      now: NOW,
      reclaimGraceMs: 60_000,
    });
    expect(expected.kind).toBe('reply');
    expect(router.fleetFromDatabase).toHaveBeenCalledWith(GUILD, FULL_FLEET);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expected.kind === 'reply' ? expected.message : '' }),
    );
    expect(router.handOver).not.toHaveBeenCalled();
    expect(router.claimAndHandOver).not.toHaveBeenCalled();
  });

  it('takes the wording of the second look, which can name a stopped player to invite', async () => {
    const router = deps({
      readFleet: vi.fn(() => Promise.resolve(snapshot(FULL_FLEET))),
      fleetFromDatabase: vi.fn(() =>
        Promise.resolve(
          fleetOf(FULL_FLEET, [{ botId: 'player-4', clientId: P4_CLIENT }], [MAIN_CLIENT]),
        ),
      ),
    });
    const interaction = fakeCommand();

    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('**player-4**') }),
    );
  });

  it('follows the holder of the room when it loses the race for a bot', async () => {
    const router = deps({
      claimAndHandOver: vi.fn(() => Promise.resolve({ kind: 'lost' as const, holder: 'player-2' })),
    });

    await routeGatewayCommand(fakeClient(), fakeCommand(), fakeLogger(), router);

    const claimed = envelopeHandedTo(router, 'claimAndHandOver');
    const followed = envelopeHandedTo(router, 'handOver');
    expect(followed.botId).toBe('player-2');
    expect(followed.envelope).toEqual(claimed.envelope);
  });

  it('says every player is busy when it loses the race and nobody holds the room', async () => {
    const router = deps({
      claimAndHandOver: vi.fn(() => Promise.resolve({ kind: 'lost' as const, holder: null })),
    });
    const interaction = fakeCommand();

    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router);

    expect(router.handOver).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Every player is busy in another channel right now. Try again shortly.',
      }),
    );
  });

  it('checks for pickup at the same intervals as the HTTP router', async () => {
    const router = deps();
    const redis = fakeRedis(null);

    await routeGatewayCommand(fakeClient({ redis }), fakeCommand(), fakeLogger(), router);

    expect(vi.mocked(router.sleep).mock.calls.map(([ms]) => ms)).toEqual([...PICKUP_CHECKS_MS]);
    expect(PICKUP_CHECKS_MS).toEqual([400, 900]);
    expect(redis.get).toHaveBeenCalledWith(interactionAckKey('int-1'));
  });

  it('tells the caller when the chosen bot never picks the command up', async () => {
    const router = deps({
      readFleet: vi.fn(() => Promise.resolve(snapshot(OWNED_FLEET, 'player-2'))),
    });
    const interaction = fakeCommand();

    await routeGatewayCommand(
      fakeClient({ redis: fakeRedis(null) }),
      interaction,
      fakeLogger(),
      router,
    );

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '**player-2** did not respond. Try again in a moment.' }),
    );
  });

  it('stays quiet once the bot has acknowledged pickup', async () => {
    const interaction = fakeCommand();
    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), deps());
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('says the control channel is unavailable when the fleet cannot be read', async () => {
    const router = deps({
      readFleet: vi.fn(() => Promise.reject(new FleetUnavailableError(new Error('ECONNRESET')))),
    });
    const interaction = fakeCommand();

    await expect(
      routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router),
    ).resolves.toBeUndefined();

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The bot's control channel is unavailable right now. Try again shortly.",
      }),
    );
  });

  it('answers any other failure with the generic routing message, and never throws', async () => {
    const router = deps({
      handOver: vi.fn(() => Promise.reject(new Error('boom'))),
      readFleet: vi.fn(() => Promise.resolve(snapshot(OWNED_FLEET, 'player-2'))),
    });
    const interaction = fakeCommand();

    await expect(
      routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router),
    ).resolves.toBeUndefined();

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Something went wrong routing that command. Try again shortly.',
      }),
    );
  });

  it('never throws even when the error reply itself fails', async () => {
    const router = deps({ readFleet: vi.fn(() => Promise.reject(new Error('boom'))) });
    const interaction = fakeCommand();
    interaction.editReply.mockRejectedValue(new Error('Unknown Webhook'));

    await expect(
      routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router),
    ).resolves.toBeUndefined();
  });

  it('stops when the interaction is already dead at acknowledgement', async () => {
    const router = deps();
    const interaction = fakeCommand();
    interaction.deferReply.mockRejectedValue(Object.assign(new Error('Unknown'), { code: 10062 }));

    await routeGatewayCommand(fakeClient(), interaction, fakeLogger(), router);

    expect(router.readFleet).not.toHaveBeenCalled();
    expect(dispatchChatInputCommand).not.toHaveBeenCalled();
  });

  it('runs locally, as before, when there is no Redis', async () => {
    const router = deps();
    const interaction = fakeCommand();
    const client = fakeClient({ redis: undefined });

    await routeGatewayCommand(client, interaction, fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledWith(client, interaction, expect.anything());
    expect(router.readFleet).not.toHaveBeenCalled();
    // The local dispatcher acknowledges for itself.
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('runs locally when Redis is not connected', async () => {
    const router = deps();
    const redis = { ...fakeRedis(), status: 'reconnecting' };
    const client = fakeClient({ redis });

    await routeGatewayCommand(client, fakeCommand(), fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledTimes(1);
    expect(router.readFleet).not.toHaveBeenCalled();
  });

  it('runs locally when the raw payload was never captured', async () => {
    const router = deps();
    const client = fakeClient({ raw: undefined });

    await routeGatewayCommand(client, fakeCommand(), fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledTimes(1);
    expect(router.readFleet).not.toHaveBeenCalled();
  });

  it('leaves unknown commands to the local dispatcher, and still forgets the payload', async () => {
    const router = deps();
    const client = fakeClient({ commands: {} });

    await routeGatewayCommand(client, fakeCommand(), fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledTimes(1);
    expect(router.readFleet).not.toHaveBeenCalled();
    expect(client.rawInteractions.size).toBe(0);
  });

  it('leaves DMs to the local dispatcher', async () => {
    const router = deps();

    await routeGatewayCommand(fakeClient(), fakeCommand({ guildId: null }), fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledTimes(1);
    expect(router.readFleet).not.toHaveBeenCalled();
  });

  it('does not route on a player bot', async () => {
    const router = deps();
    const interaction = fakeCommand();
    const client = fakeClient({ role: 'player' });

    await routeGatewayCommand(client, interaction, fakeLogger(), router);

    expect(dispatchChatInputCommand).toHaveBeenCalledWith(client, interaction, expect.anything());
    expect(router.readFleet).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});

interface FakeComponentInteraction {
  id: string;
  customId: string;
  guildId: string | null;
  deferred: boolean;
  replied: boolean;
  deferUpdate: ReturnType<typeof vi.fn>;
}

function rawComponent(id: string, customId: string): RawInteraction {
  return {
    id,
    application_id: APP,
    token: `token-${id}`,
    type: 3,
    guild_id: GUILD,
    channel_id: '666666666666666666',
    member: { user: { id: USER } },
    message: { id: '777777777777777777', author: { id: MAIN_CLIENT } },
    data: { custom_id: customId, component_type: 2 },
  };
}

function fakeComponent(
  customId: string,
  id = 'cmp-1',
): FakeComponentInteraction & MessageComponentInteraction {
  const interaction: FakeComponentInteraction = {
    id,
    customId,
    guildId: GUILD,
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(() => {
      order.push('deferUpdate');
      interaction.deferred = true;
      return Promise.resolve();
    }),
  };
  return interaction as unknown as FakeComponentInteraction & MessageComponentInteraction;
}

describe('routeGatewayComponent', () => {
  const TAGGED = 'spl:next#player-3';

  it('hands a component tagged for another bot to that bot, deferring first', async () => {
    const router = deps();
    const client = fakeClient({ raw: rawComponent('cmp-1', TAGGED) });
    const interaction = fakeComponent(TAGGED);

    const handled = await routeGatewayComponent(client, interaction, fakeLogger(), router);

    expect(handled).toBe(true);
    expect(order[0]).toBe('deferUpdate');
    const { botId, envelope } = envelopeHandedTo(router, 'handOver');
    expect(botId).toBe('player-3');
    expect(envelope).toMatchObject({
      payload: rawComponent('cmp-1', TAGGED),
      deferral: 'ephemeral',
      voiceChannelId: null,
      routedAt: NOW,
    });
  });

  it('leaves an untagged component to local handling', async () => {
    const router = deps();
    const client = fakeClient({ raw: rawComponent('cmp-1', 'music:pause') });
    const interaction = fakeComponent('music:pause');

    const handled = await routeGatewayComponent(client, interaction, fakeLogger(), router);

    expect(handled).toBe(false);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(router.handOver).not.toHaveBeenCalled();
    expect(client.rawInteractions.size).toBe(0);
  });

  it("leaves a component tagged with main's own name to local handling", async () => {
    const router = deps();
    const client = fakeClient({ raw: rawComponent('cmp-1', 'spl:next#main') });

    const handled = await routeGatewayComponent(
      client,
      fakeComponent('spl:next#main'),
      fakeLogger(),
      router,
    );

    expect(handled).toBe(false);
    expect(router.handOver).not.toHaveBeenCalled();
  });

  it('leaves a component that is already deferred alone, so a re-emitted routed click is not routed again', async () => {
    const router = deps();
    const client = fakeClient({ raw: rawComponent('cmp-1', TAGGED) });
    const interaction = fakeComponent(TAGGED);
    interaction.deferred = true;

    const handled = await routeGatewayComponent(client, interaction, fakeLogger(), router);

    expect(handled).toBe(false);
    expect(router.handOver).not.toHaveBeenCalled();
  });

  it('handles locally when there is no raw payload or no Redis', async () => {
    const router = deps();

    expect(
      await routeGatewayComponent(
        fakeClient({ raw: undefined }),
        fakeComponent(TAGGED),
        fakeLogger(),
        router,
      ),
    ).toBe(false);
    expect(
      await routeGatewayComponent(
        fakeClient({ raw: rawComponent('cmp-1', TAGGED), redis: undefined }),
        fakeComponent(TAGGED),
        fakeLogger(),
        router,
      ),
    ).toBe(false);
    expect(router.handOver).not.toHaveBeenCalled();
  });

  it('drops a component tagged for a bot the fleet has never heard of', async () => {
    const router = deps();
    const tag = 'spl:next#player-99';
    const interaction = fakeComponent(tag);

    const handled = await routeGatewayComponent(
      fakeClient({ raw: rawComponent('cmp-1', tag) }),
      interaction,
      fakeLogger(),
      router,
    );

    expect(handled).toBe(true);
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(router.handOver).not.toHaveBeenCalled();
  });

  it('never throws when the hand-over fails', async () => {
    const router = deps({ handOver: vi.fn(() => Promise.reject(new Error('boom'))) });

    await expect(
      routeGatewayComponent(
        fakeClient({ raw: rawComponent('cmp-1', TAGGED) }),
        fakeComponent(TAGGED),
        fakeLogger(),
        router,
      ),
    ).resolves.toBe(true);
  });

  it('does nothing on a player bot', async () => {
    const router = deps();
    const interaction = fakeComponent(TAGGED);

    const handled = await routeGatewayComponent(
      fakeClient({ role: 'player', raw: rawComponent('cmp-1', TAGGED) }),
      interaction,
      fakeLogger(),
      router,
    );

    expect(handled).toBe(false);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});
