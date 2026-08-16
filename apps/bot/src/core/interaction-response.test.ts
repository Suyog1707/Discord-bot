/**
 * Interaction lifecycle safety.
 *
 * These cover the exact failure that produced a pair of `10062 Unknown
 * interaction` errors per incident: an interaction whose acknowledgement
 * window had closed, followed by an error handler that tried to respond
 * through it anyway.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../lib/logger.js';
import {
  acknowledge,
  claimInteraction,
  isDeadInteraction,
  rejectGuard,
  replyWithError,
} from './interaction-response.js';

/** Discord.js surfaces API failures as an error carrying a numeric `code`. */
function discordError(code: number): Error {
  return Object.assign(new Error(`DiscordAPIError[${String(code)}]`), { code });
}

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

interface FakeInteraction {
  deferred: boolean;
  replied: boolean;
  ephemeral: boolean;
  createdTimestamp: number;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  deleteReply: ReturnType<typeof vi.fn>;
}

function fakeInteraction(overrides: Partial<FakeInteraction> = {}): FakeInteraction {
  return {
    deferred: false,
    replied: false,
    ephemeral: false,
    createdTimestamp: Date.now(),
    reply: vi.fn((): Promise<void> => Promise.resolve()),
    editReply: vi.fn((): Promise<void> => Promise.resolve()),
    followUp: vi.fn((): Promise<void> => Promise.resolve()),
    deferReply: vi.fn((): Promise<void> => Promise.resolve()),
    deleteReply: vi.fn((): Promise<void> => Promise.resolve()),
    ...overrides,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

describe('isDeadInteraction', () => {
  it('recognises an expired interaction', () => {
    expect(isDeadInteraction(discordError(10062))).toBe(true);
  });

  it('recognises an already-acknowledged interaction', () => {
    expect(isDeadInteraction(discordError(40060))).toBe(true);
  });

  it('does not swallow unrelated Discord errors', () => {
    expect(isDeadInteraction(discordError(50013))).toBe(false);
    expect(isDeadInteraction(new Error('network down'))).toBe(false);
    expect(isDeadInteraction(null)).toBe(false);
  });
});

describe('claimInteraction', () => {
  it('lets exactly one handler own an interaction id', () => {
    const id = `first-${String(Date.now())}`;
    expect(claimInteraction(id)).toBe(true);
    expect(claimInteraction(id)).toBe(false);
    expect(claimInteraction(id)).toBe(false);
  });

  it('treats distinct ids independently', () => {
    const stamp = String(Date.now());
    expect(claimInteraction(`a-${stamp}`)).toBe(true);
    expect(claimInteraction(`b-${stamp}`)).toBe(true);
  });
});

describe('replyWithError', () => {
  it('edits the deferred reply rather than replying again', async () => {
    const interaction = fakeInteraction({ deferred: true });

    await expect(replyWithError(interaction as any, 'boom', fakeLogger())).resolves.toBe(true);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'boom' });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('follows up when the interaction was already replied to', async () => {
    const interaction = fakeInteraction({ replied: true });

    await replyWithError(interaction as any, 'boom', fakeLogger());

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('replies when the interaction is untouched', async () => {
    const interaction = fakeInteraction();

    await replyWithError(interaction as any, 'boom', fakeLogger());

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('gives up on 10062 instead of producing a second Unknown interaction', async () => {
    const interaction = fakeInteraction({
      reply: vi.fn((): Promise<void> => Promise.reject(discordError(10062))),
    });
    const logger = fakeLogger();

    // The whole point: this must not throw, and must not try another verb.
    await expect(replyWithError(interaction as any, 'boom', logger)).resolves.toBe(false);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports an unrelated delivery failure without throwing', async () => {
    const interaction = fakeInteraction({
      reply: vi.fn((): Promise<void> => Promise.reject(discordError(50013))),
    });
    const logger = fakeLogger();

    await expect(replyWithError(interaction as any, 'boom', logger)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('acknowledge', () => {
  it('defers publicly for a public command', async () => {
    const interaction = fakeInteraction();

    await expect(acknowledge(interaction as any, 'public', fakeLogger())).resolves.toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledWith({});
  });

  it('defers ephemerally when asked', async () => {
    const interaction = fakeInteraction();

    await acknowledge(interaction as any, 'ephemeral', fakeLogger());

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply.mock.calls[0]?.[0]).not.toEqual({});
  });

  it('never acknowledges twice', async () => {
    const interaction = fakeInteraction({ deferred: true });

    await expect(acknowledge(interaction as any, 'public', fakeLogger())).resolves.toBe(true);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('reports an expired interaction as unusable rather than throwing', async () => {
    const interaction = fakeInteraction({
      deferReply: vi.fn((): Promise<void> => Promise.reject(discordError(10062))),
    });
    const logger = fakeLogger();

    await expect(acknowledge(interaction as any, 'public', logger)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('propagates a genuine failure so it is not mistaken for expiry', async () => {
    const interaction = fakeInteraction({
      deferReply: vi.fn((): Promise<void> => Promise.reject(discordError(50013))),
    });

    await expect(acknowledge(interaction as any, 'public', fakeLogger())).rejects.toThrow();
  });
});

describe('rejectGuard', () => {
  it('keeps the rejection private when the command deferred publicly', async () => {
    const interaction = fakeInteraction({ deferred: true, ephemeral: false });

    await rejectGuard(interaction as any, 'on cooldown', fakeLogger());

    // The public "thinking" placeholder is removed and the reason sent privately.
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('edits in place when the deferral was already ephemeral', async () => {
    const interaction = fakeInteraction({ deferred: true, ephemeral: true });

    await rejectGuard(interaction as any, 'on cooldown', fakeLogger());

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'on cooldown' });
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it('stops cleanly when the interaction died before the rejection', async () => {
    const interaction = fakeInteraction({
      deferred: true,
      ephemeral: false,
      deleteReply: vi.fn((): Promise<void> => Promise.reject(discordError(10062))),
    });

    await expect(
      rejectGuard(interaction as any, 'on cooldown', fakeLogger()),
    ).resolves.toBeUndefined();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
