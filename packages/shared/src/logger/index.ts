/**
 * Structured logging built on pino.
 *
 * - Development: human-readable, colourised output via `pino-pretty`.
 * - Production:  newline-delimited JSON for log shippers.
 *
 * Secrets are redacted centrally so no call site has to remember to omit them.
 */
import {
  pino,
  stdSerializers,
  stdTimeFunctions,
  type Level,
  type Logger as PinoLogger,
} from 'pino';

import { isAppError } from '../errors/index.js';

export type Logger = PinoLogger;
export type LogLevel = Level;

/** Paths scrubbed from every log record (docs/SECURITY.md). */
const REDACTED_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'DATABASE_URL',
  'REDIS_URL',
  'BOT_TOKEN',
  'NEXTAUTH_SECRET',
  'DISCORD_CLIENT_SECRET',
  'LAVALINK_PASSWORD',
];

export interface CreateLoggerOptions {
  /** Service name attached to every record, e.g. `"bot"` or `"web"`. */
  readonly name: string;
  readonly level: LogLevel;
  /** Pretty-print instead of JSON. Defaults to `true` outside production. */
  readonly pretty?: boolean;
  /** Extra static fields merged into every record. */
  readonly base?: Readonly<Record<string, unknown>>;
}

/**
 * Create the root logger for a service.
 *
 * Call once per process and derive per-module loggers with `child()`.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { name, level, pretty = true, base } = options;

  return pino({
    name,
    level,
    base: { service: name, ...base },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      // Emit `"level":"info"` rather than `"level":30` for readability.
      level: (label) => ({ level: label }),
    },
    timestamp: stdTimeFunctions.isoTime,
    /**
     * `AppError`s carry a code and status worth indexing; keep them on the
     * serialised record alongside pino's standard error fields.
     */
    serializers: {
      err: (error: unknown) => {
        const serialized = stdSerializers.err(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (isAppError(error)) {
          return {
            ...serialized,
            code: error.code,
            statusCode: error.statusCode,
            expected: error.expected,
            retryable: error.retryable,
            details: error.details,
          };
        }
        return serialized;
      },
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service',
              messageFormat: '{if module}[{module}] {end}{msg}',
              singleLine: false,
            },
          },
        }
      : {}),
  });
}

/** Derive a namespaced child logger: `logger.child({ module })`. */
export function childLogger(parent: Logger, module: string): Logger {
  return parent.child({ module });
}

export { pino };
