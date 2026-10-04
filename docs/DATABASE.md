# Database

User, Guild, Playlist, Queue, SongHistory, Verification, Session.

## Local Docker services

`pnpm docker:up` now starts PostgreSQL and Redis alongside Lavalink and the
bots. Set `POSTGRES_PASSWORD` and `REDIS_PASSWORD` in the ignored root `.env`
before starting. The database migration service waits for PostgreSQL readiness
and applies committed Prisma migrations. Docker volumes
`postgres-data-2026` and `redis-data-2026` persist across container restarts;
older volumes are deliberately left untouched.

Both services bind only to `127.0.0.1` on the host. Every Compose bot and the
web backend use the Docker service names `postgres` and `redis`, regardless of
the host-side URLs in `.env`. For host-side `pnpm dev`, set `DATABASE_URL` and
`DIRECT_URL` to `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:<POSTGRES_PORT>/<POSTGRES_DB>`
and `REDIS_URL` to `redis://:<REDIS_PASSWORD>@127.0.0.1:<REDIS_PORT>`.
Never commit these values.

Host ports are PostgreSQL `20001`, Redis `20002`, Lavalink `20003`, and
the web gateway `20900`. All bind to loopback only. Container-internal
ports remain unchanged; Next.js and bot health endpoints are not published.
Check for existing listeners before deploying to a shared VPS.

Check startup with `docker compose --env-file .env -f docker/docker-compose.yml
ps`. A successful `postgres-migrate` container exits with status 0; the
PostgreSQL and Redis containers remain healthy. Never run
`docker compose down --volumes` unless you intend to delete local data.

## Local web backend

The same Compose stack runs a production Next.js `web-backend` with local
PostgreSQL and Redis URLs. It has no published port. A Caddy `web-gateway`
listens only on `127.0.0.1:20900` and requires `X-Origin-Secret` to match the
ignored `.env` value `ORIGIN_SECRET` before proxying any path. Generate this
with `openssl rand -hex 32`; never put it in a browser-visible variable. A
direct request to the gateway without that header must return 403. Tailscale
Funnel exposes this gateway, not the database, Redis, or raw web server.

## Recovery completed on the PC

The old Supabase `public` schema was exported to a private custom-format dump
outside Git and restored as **data only** into the Prisma-migrated local
database. Exact counts matched across all 20 tables (including 713 history
rows and 71 favorites), and a three-row history checksum matched. The source
had zero playlists. `prisma migrate deploy` reported no pending migrations.
Redis was deliberately started empty; old presence, claims, and queues were
not replayed. Keep the old Supabase project and the private dump until PC and
VPS acceptance tests are complete. Do not run PC and VPS bots with the same
Discord tokens concurrently.
