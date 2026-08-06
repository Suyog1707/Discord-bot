/**
 * PrismaClient factory and process-wide singleton.
 *
 * Next.js hot-reloads modules in development; without a global cache each
 * reload opens a fresh connection pool until Postgres refuses new connections.
 * Caching on `globalThis` keeps exactly one client per process.
 */
import { Prisma, PrismaClient } from '@prisma/client';

export interface CreatePrismaClientOptions {
  readonly databaseUrl: string;
  /** Emit query-level logs. Enable in development only — queries can contain PII. */
  readonly logQueries?: boolean;
}

export function createPrismaClient({
  databaseUrl,
  logQueries = false,
}: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: logQueries
      ? ['query', 'info', 'warn', 'error']
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
    errorFormat: 'pretty',
  });
}

// Typed as `unique symbol` so the property below stays optional rather than
// collapsing into a `[key: symbol]` index signature.
const PRISMA_SINGLETON_KEY: unique symbol = Symbol.for('discord-music.prisma');

// `| undefined` is explicit because `exactOptionalPropertyTypes` otherwise
// forbids assigning `undefined` to clear the slot in `disconnectPrisma`.
type PrismaGlobal = typeof globalThis & { [PRISMA_SINGLETON_KEY]?: PrismaClient | undefined };

/** Get (or lazily create) the shared client. Safe across hot-reloads. */
export function getPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const scope = globalThis as PrismaGlobal;

  const existing = scope[PRISMA_SINGLETON_KEY];
  if (existing) return existing;

  const client = createPrismaClient(options);
  scope[PRISMA_SINGLETON_KEY] = client;
  return client;
}

/** Disconnect the shared client — call from a graceful-shutdown handler. */
export async function disconnectPrisma(): Promise<void> {
  const scope = globalThis as PrismaGlobal;
  const client = scope[PRISMA_SINGLETON_KEY];

  if (client) {
    await client.$disconnect();
    // Cleared rather than deleted so a subsequent `getPrismaClient` rebuilds it.
    scope[PRISMA_SINGLETON_KEY] = undefined;
  }
}

/** `SELECT 1` health probe used by `/api/health` and the bot's readiness check. */
export async function pingDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Prisma's "unique constraint violated" error. */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Prisma's "record not found" error. */
export function isRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/** Prisma's "foreign key constraint failed" error. */
export function isForeignKeyError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
