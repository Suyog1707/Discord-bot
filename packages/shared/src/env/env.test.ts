import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../errors/index.js';
import { botEnvSchema, parseEnv, webEnvSchema } from './index.js';

const validBotEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  BOT_TOKEN: 'a-token',
  BOT_CLIENT_ID: '123456789012345678',
  BOT_PUBLIC_KEY: 'a-public-key',
  LAVALINK_HOST: 'localhost',
  LAVALINK_PORT: '2333',
  LAVALINK_PASSWORD: 'youshallnotpass',
  LAVALINK_SECURE: 'false',
} as const;

describe('botEnvSchema', () => {
  it('parses and coerces a complete environment', () => {
    const env = parseEnv(botEnvSchema, validBotEnv, 'apps/bot');

    expect(env.LAVALINK_PORT).toBe(2333);
    expect(env.LAVALINK_SECURE).toBe(false);
    expect(env.NODE_ENV).toBe('test');
  });

  it('applies defaults for optional values', () => {
    const { LAVALINK_PORT: _port, LAVALINK_SECURE: _secure, ...rest } = validBotEnv;
    const env = parseEnv(botEnvSchema, rest, 'apps/bot');

    expect(env.LAVALINK_PORT).toBe(2333);
    expect(env.LAVALINK_SECURE).toBe(false);
  });

  it('accepts booleanish spellings of LAVALINK_SECURE', () => {
    for (const [input, expected] of [
      ['true', true],
      ['1', true],
      ['YES', true],
      ['false', false],
      ['0', false],
    ] as const) {
      const env = parseEnv(botEnvSchema, { ...validBotEnv, LAVALINK_SECURE: input });
      expect(env.LAVALINK_SECURE).toBe(expected);
    }
  });

  it('treats a blank optional variable as unset', () => {
    // `.env.example` ships `BOT_DEV_GUILD_ID=` and `--env-file` loads it as ''.
    const env = parseEnv(botEnvSchema, { ...validBotEnv, BOT_DEV_GUILD_ID: '' }, 'apps/bot');
    expect(env.BOT_DEV_GUILD_ID).toBeUndefined();
  });

  it('still validates an optional variable that has a value', () => {
    expect(() => parseEnv(botEnvSchema, { ...validBotEnv, BOT_DEV_GUILD_ID: 'bad' })).toThrow(
      /Must be a valid Discord ID/u,
    );

    const env = parseEnv(botEnvSchema, {
      ...validBotEnv,
      BOT_DEV_GUILD_ID: '987654321098765432',
    });
    expect(env.BOT_DEV_GUILD_ID).toBe('987654321098765432');
  });

  it('rejects a non-snowflake BOT_CLIENT_ID', () => {
    expect(() => parseEnv(botEnvSchema, { ...validBotEnv, BOT_CLIENT_ID: 'nope' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      parseEnv(botEnvSchema, { ...validBotEnv, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL must be a PostgreSQL connection string/u);
  });

  it('reports every missing variable at once', () => {
    let message = '';
    try {
      parseEnv(botEnvSchema, { NODE_ENV: 'test' }, 'apps/bot');
    } catch (error) {
      message = (error as ConfigurationError).message;
    }

    expect(message).toContain('apps/bot');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('BOT_TOKEN');
    expect(message).toContain('LAVALINK_HOST');
  });

  it('returns a frozen object', () => {
    const env = parseEnv(botEnvSchema, validBotEnv);
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('webEnvSchema', () => {
  it('rejects a NEXTAUTH_SECRET shorter than 32 characters', () => {
    expect(() =>
      parseEnv(webEnvSchema, {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        NEXTAUTH_URL: 'http://localhost:3000',
        NEXTAUTH_SECRET: 'too-short',
        DISCORD_CLIENT_ID: '123456789012345678',
        DISCORD_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/at least 32 characters/u);
  });
});
