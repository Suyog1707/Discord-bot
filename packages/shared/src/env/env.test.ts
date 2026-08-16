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

  // DIRECT_URL is the migration-only connection: Prisma Migrate uses it,
  // no running app does. It must therefore never be required at boot, but a
  // typo in it should still surface at `check:env` rather than mid-deploy.
  it('accepts a missing or blank DIRECT_URL', () => {
    expect(parseEnv(botEnvSchema, validBotEnv).DIRECT_URL).toBeUndefined();
    expect(parseEnv(botEnvSchema, { ...validBotEnv, DIRECT_URL: '' }).DIRECT_URL).toBeUndefined();
  });

  it('rejects a non-PostgreSQL DIRECT_URL', () => {
    expect(() =>
      parseEnv(botEnvSchema, { ...validBotEnv, DIRECT_URL: 'mysql://localhost/db' }),
    ).toThrow(/DIRECT_URL must be a PostgreSQL connection string/u);
  });

  it('reports every missing required variable at once', () => {
    let message = '';
    try {
      parseEnv(botEnvSchema, { NODE_ENV: 'test' }, 'apps/bot');
    } catch (error) {
      message = (error as ConfigurationError).message;
    }

    expect(message).toContain('apps/bot');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('BOT_TOKEN');
    expect(message).toContain('BOT_CLIENT_ID');
    // Redis and Lavalink are optional outside production, so they must not be
    // reported here — see the "optional infrastructure" suite below.
    expect(message).not.toContain('LAVALINK_HOST');
    expect(message).not.toContain('REDIS_URL');
  });

  it('returns a frozen object', () => {
    const env = parseEnv(botEnvSchema, validBotEnv);
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('optional infrastructure', () => {
  const withoutOptional = () => {
    const {
      REDIS_URL: _redis,
      LAVALINK_HOST: _host,
      LAVALINK_PASSWORD: _password,
      ...rest
    } = validBotEnv;
    return rest;
  };

  it('allows Redis and Lavalink to be omitted outside production', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      const env = parseEnv(botEnvSchema, { ...withoutOptional(), NODE_ENV: nodeEnv }, 'apps/bot');

      expect(env.REDIS_URL).toBeUndefined();
      expect(env.LAVALINK_HOST).toBeUndefined();
      expect(env.LAVALINK_PASSWORD).toBeUndefined();
    }
  });

  it('treats blank values as omitted outside production', () => {
    const env = parseEnv(botEnvSchema, {
      ...validBotEnv,
      REDIS_URL: '',
      LAVALINK_HOST: '',
      LAVALINK_PASSWORD: '',
    });

    expect(env.REDIS_URL).toBeUndefined();
    expect(env.LAVALINK_HOST).toBeUndefined();
  });

  it('requires all of them in production, reporting each by name', () => {
    let message = '';
    try {
      parseEnv(botEnvSchema, { ...withoutOptional(), NODE_ENV: 'production' }, 'apps/bot');
      expect.unreachable('should have thrown');
    } catch (error) {
      message = (error as ConfigurationError).message;
    }

    expect(message).toContain('REDIS_URL is required when NODE_ENV=production');
    expect(message).toContain('LAVALINK_HOST is required when NODE_ENV=production');
    expect(message).toContain('LAVALINK_PASSWORD is required when NODE_ENV=production');
  });

  it('accepts a fully configured production environment', () => {
    const env = parseEnv(botEnvSchema, { ...validBotEnv, NODE_ENV: 'production' }, 'apps/bot');

    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.LAVALINK_HOST).toBe('localhost');
  });

  it('still rejects a malformed value even though it is optional', () => {
    expect(() => parseEnv(botEnvSchema, { ...validBotEnv, REDIS_URL: 'http://localhost' })).toThrow(
      /must start with redis:\/\/ or rediss:\/\//u,
    );
  });

  it('requires REDIS_URL in production for the web app too', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      NEXT_PUBLIC_APP_URL: 'https://example.com',
      NEXTAUTH_URL: 'https://example.com',
      NEXTAUTH_SECRET: 'x'.repeat(32),
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_CLIENT_SECRET: 'secret',
    };

    expect(() => parseEnv(webEnvSchema, base, 'apps/web')).toThrow(
      /REDIS_URL is required when NODE_ENV=production/u,
    );
    expect(() =>
      parseEnv(webEnvSchema, { ...base, REDIS_URL: 'redis://localhost:6379' }, 'apps/web'),
    ).not.toThrow();
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
