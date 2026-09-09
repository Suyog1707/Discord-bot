/**
 * The container's private HTTP surface.
 *
 * Each bot runs in its own container, and one thing needs to reach it that a
 * Discord gateway connection cannot carry: Docker asking whether it is well.
 *
 * It used to carry more. Commands about a room another container owned were
 * forwarded here over HTTP — until the command router started sending each
 * interaction to the bot that should handle it, at which point nothing ever
 * asked a sibling for anything again.
 *
 * Bound inside the container and never published, so it is reachable by
 * service name on the compose network and from nowhere else. Node's own `http`
 * is enough for a handful of routes; a framework would be a dependency earning
 * nothing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { pingDatabase } from '@discord-music/database';

import type { BotClient } from '../core/bot-client.js';
import { getLogger } from '../lib/logger.js';

import { resolveBotHealth, type BotDependencyReport, type DependencyStatus } from './health.js';

const logger = getLogger('internal-server');

/** A probe that hangs must not hold the healthcheck open. */
const PROBE_TIMEOUT_MS = 2_000;

export interface InternalServer {
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Resolve to `false` rather than hang, so one sick dependency cannot stall the rest. */
async function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(fallback);
      }, PROBE_TIMEOUT_MS).unref();
    }),
  ]);
}

async function probe(client: BotClient): Promise<BotDependencyReport> {
  const redis = client.redis;

  const [database, redisUp] = await Promise.all([
    within(pingDatabase(client.prisma), false),
    redis === undefined
      ? Promise.resolve<DependencyStatus>('not_configured')
      : within(
          redis
            .ping()
            .then((): DependencyStatus => 'up')
            .catch((): DependencyStatus => 'down'),
          'down',
        ),
  ]);

  return {
    gateway: client.isReady() ? 'up' : 'down',
    lavalink:
      client.music === undefined ? 'not_configured' : client.music.isAvailable ? 'up' : 'down',
    database: database ? 'up' : 'down',
    redis: redisUp,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    // A cached health check is worse than no health check.
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createInternalServer(client: BotClient, port: number): InternalServer {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/health') {
      const dependencies = await probe(client);
      const health = resolveBotHealth(dependencies);
      send(response, health.httpStatus, {
        status: health.status,
        bot: {
          label: client.identity.label,
          role: client.identity.role,
          clientId: client.identity.clientId,
          instanceId: client.instanceId,
        },
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        dependencies,
      });
      return;
    }

    if (path === '/rooms') {
      // What this container is actually serving. Redis carries the same facts
      // for the fleet, so this is the direct answer — useful when that index
      // is cold, and when you want to ask one container what it thinks.
      const rooms = client.router?.ownRooms() ?? [];
      send(response, 200, { bot: client.identity.label, rooms });
      return;
    }

    send(response, 404, { error: 'Not found' });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.warn({ err: error, url: request.url }, 'Internal request failed');
      if (!response.headersSent) send(response, 500, { error: 'Internal error' });
    });
  });

  return {
    port,
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Inside the container, so siblings can reach it by service name; the
        // port is never published, so nothing outside the network can.
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
      logger.info({ port, player: client.identity.label }, 'Internal server listening');
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
