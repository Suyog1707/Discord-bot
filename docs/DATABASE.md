# Database

User, Guild, Playlist, Queue, SongHistory, Verification, Session.

## Local Docker services (migration checkpoint 1)

`pnpm docker:up` now starts PostgreSQL and Redis alongside Lavalink and the
bots. Set `POSTGRES_PASSWORD` and `REDIS_PASSWORD` in the ignored root `.env`
before starting. The database migration service waits for PostgreSQL readiness
and applies committed Prisma migrations. Docker volumes
`postgres-data-2026` and `redis-data-2026` persist across container restarts;
older volumes are deliberately left untouched.

Both services bind only to `127.0.0.1` on the host. Containers reach them by
the Docker service names `postgres` and `redis`. **At this checkpoint, the
bots and Vercel still use their existing URLs from `.env`**; importing and
verifying old data comes before switching them to local services. Do not
remove the Supabase or Upstash credentials yet.

Check startup with `docker compose --env-file .env -f docker/docker-compose.yml
ps`. A successful `postgres-migrate` container exits with status 0; the
PostgreSQL and Redis containers remain healthy. Never run
`docker compose down --volumes` unless you intend to delete local data.

## Local web backend (migration checkpoint 2)

The same Compose stack runs a production Next.js `web-backend` with local
PostgreSQL and Redis URLs. It has no published port. A Caddy `web-gateway`
listens only on `127.0.0.1:20900` and requires `X-Origin-Secret` to match the
ignored `.env` value `ORIGIN_SECRET` before proxying any path. Generate this
with `openssl rand -hex 32`; never put it in a browser-visible variable. A
direct request to the gateway without that header must return 403. Tailscale
Funnel will expose this gateway in a later checkpoint, not the database,
Redis, or raw web server.
