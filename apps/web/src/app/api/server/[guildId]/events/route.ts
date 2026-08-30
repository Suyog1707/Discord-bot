/**
 * GET /api/server/:guildId/events — real-time player state (SSE).
 *
 * The realtime layer: the bot publishes a full state snapshot to Redis on
 * every player change; this stream relays the guild's events to the browser
 * as Server-Sent Events. SSE (rather than a raw WebSocket) keeps the
 * transport inside a standard route handler — no custom server — and the
 * validated POST /api/player/:guildId channel already carries commands the
 * other way, so together they form a full-duplex control link.
 *
 * Each connection opens a dedicated Redis subscriber (a subscribing
 * connection cannot multiplex regular commands), closed on client abort — so
 * the opening snapshot is read over the shared command connection instead.
 */
import {
  decodePlayerEvent,
  PLAYER_EVENT_CHANNEL,
  playerStateKey,
  UpstreamError,
  type PlayerEvent,
} from '@discord-music/shared';
import { createRedisClient } from '@discord-music/shared/redis';
import { NextResponse, type NextRequest } from 'next/server';

import { withErrorHandling } from '@/lib/api';
import { requireUser } from '@/lib/auth/session';
import { requireManagedGuild } from '@/lib/authz';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';
import { initialPlayerEvent } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Keep intermediaries from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

export const GET = withErrorHandling(
  'GET /api/server/:guildId/events',
  async (request: NextRequest, context: { params: Promise<{ guildId: string }> }) => {
    const user = await requireUser();
    const { guildId } = await context.params;
    await requireManagedGuild(user.id, guildId);

    const redisUrl = getEnv().REDIS_URL;
    if (redisUrl === undefined) {
      throw new UpstreamError(
        'Live updates are unavailable: the realtime backend (Redis) is not configured.',
      );
    }

    const logger = getLogger('sse').child({ guildId, userId: user.id });
    const subscriber = createRedisClient({ url: redisUrl, logger });
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const cleanups: (() => void)[] = [];

        const close = () => {
          if (closed) return;
          closed = true;
          for (const cleanup of cleanups) cleanup();
          subscriber.disconnect();
          try {
            controller.close();
          } catch {
            /* already closed by the runtime */
          }
        };

        const send = (event: PlayerEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            close();
          }
        };

        try {
          await subscriber.connect();
          await subscriber.subscribe(PLAYER_EVENT_CHANNEL);
        } catch (error) {
          logger.warn({ err: error }, 'SSE Redis subscribe failed');
          close();
          return;
        }

        subscriber.on('message', (channel: string, raw: string) => {
          if (channel !== PLAYER_EVENT_CHANNEL) return;
          const event = decodePlayerEvent(raw);
          if (event !== null && event.guildId === guildId) send(event);
        });

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            close();
          }
        }, HEARTBEAT_MS);
        cleanups.push(() => {
          clearInterval(heartbeat);
        });

        request.signal.addEventListener('abort', close);

        // Opening snapshot, deliberately read *after* subscribing: the bot
        // retains the latest full state under a per-guild key, and reading it
        // second means an event landing in the gap is merely delivered twice.
        // Full-state events make that duplication harmless — a missed event is
        // the only real failure, and subscribe-first rules it out. A read over
        // the subscriber would be rejected (subscribed connections take no
        // commands), so this uses the shared command client. Reconnects get a
        // fresh snapshot by construction, with no extra resume protocol.
        try {
          const raw = (await getRedis()?.get(playerStateKey(guildId))) ?? null;
          const initial = initialPlayerEvent(raw, guildId);
          if (initial !== null) send(initial);
        } catch (error) {
          // A missing snapshot is not worth dropping a working stream over:
          // the dashboard keeps its server-rendered state and the next event
          // corrects it.
          logger.warn({ err: error }, 'SSE initial snapshot read failed');
        }
      },
      cancel() {
        subscriber.disconnect();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);
