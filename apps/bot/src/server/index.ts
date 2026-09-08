/**
 * The container's private HTTP surface.
 *
 * Each bot runs in its own container, and two things need to reach it that a
 * Discord gateway connection cannot carry: Docker asking whether it is well,
 * and — once the fleet is split across containers — a sibling asking it to act
 * on a room it owns.
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
import { applyIntent } from '../music/apply-intent.js';
import { decodeIntent } from '../music/intent.js';
import { decodeJoinRequest } from '../music/join-request.js';

import { resolveBotHealth, type BotDependencyReport, type DependencyStatus } from './health.js';

const logger = getLogger('internal-server');

/** A probe that hangs must not hold the healthcheck open. */
const PROBE_TIMEOUT_MS = 2_000;

/** Generous for a control message; a body larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

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

    if (path === '/join' && request.method === 'POST') {
      // The only call about a room that does not exist yet: every intent acts
      // on a player that is already there, and this is what puts one there.
      // Allocation has already happened on the primary, so there is nothing
      // left to choose — only to do it, or to say why it cannot.
      const options = decodeJoinRequest(await readJson(request));
      if (options === null) {
        send(response, 400, { kind: 'error', message: 'Malformed join request' });
        return;
      }

      const router = client.router;
      if (router === undefined) {
        send(response, 503, { kind: 'error', message: 'This player has no audio server.' });
        return;
      }

      logger.info(
        { guildId: options.guildId, voiceChannelId: options.voiceChannelId },
        'Taking a room on request',
      );
      send(response, 200, await router.joinLocal(options));
      return;
    }

    if (path === '/intent' && request.method === 'POST') {
      const intent = decodeIntent(await readJson(request));
      if (intent === null) {
        send(response, 400, { error: 'Malformed intent' });
        return;
      }

      // The owner is asked directly, so a room this container does not serve
      // is a routing mistake by the caller rather than something to guess at.
      const room = client.router?.roomFor(intent.guildId, intent.voiceChannelId);
      if (room === undefined) {
        send(response, 409, {
          kind: 'error',
          message: 'This container does not serve that room.',
        });
        return;
      }

      logger.info(
        {
          action: intent.action,
          guildId: intent.guildId,
          voiceChannelId: intent.voiceChannelId,
          issuedBy: intent.issuedBy,
        },
        'Applying intent',
      );
      send(response, 200, await applyIntent(room, intent));
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
