# Database

PostgreSQL and Redis are self-hosted by `docker/docker-compose.yml` and start
with the rest of the stack:

```bash
pnpm docker:up
```

PostgreSQL data is retained in the `postgres-data-self-hosted` named volume. The one-shot
`postgres-migrate` service waits for PostgreSQL and applies all committed Prisma
migrations before any bot container starts. Redis uses append-only persistence
in the `redis-data` volume.

The default host connections are:

- PostgreSQL: `postgresql://discord_music:discord_music@localhost:5432/discord_music`
- Redis: `redis://localhost:6379`

Both ports bind to `127.0.0.1`, not every network interface. Set
`POSTGRES_PORT` or `REDIS_PORT` in `.env` if either default port is occupied.
Set `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` before the first boot
to choose different database credentials; PostgreSQL stores initialization
credentials in its data volume, so later edits do not change an existing
database user.

The Prisma schema includes users, guilds, playlists, queues, song history,
verification tokens, sessions, favorites, dislikes, taste profiles, and player
presence records.
