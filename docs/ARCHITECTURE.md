# Architecture

Monorepo (pnpm + Turborepo):

- `apps/web` — Next.js 15 dashboard (App Router). Auth.js v5 (Discord OAuth,
  database sessions), service layer over Prisma, REST API with a uniform
  envelope, rate limiting, CSP.
- `apps/bot` — discord.js 14 bot. Filesystem-discovered commands/events,
  guard pipeline, Lavalink playback via Shoukaku, queue persistence.
- `packages/shared` — isomorphic types, Zod validation, AppError hierarchy,
  env schemas, pino logging, Redis factory, player-command schema.
- `packages/database` — Prisma schema, migrations, client singleton.

## Data flow

```
Discord user ──/play──▶ apps/bot ──▶ Lavalink (audio)
                          │ writes queue snapshot + history
                          ▼
                      PostgreSQL ◀── reads ── apps/web (dashboard)
                          ▲
Dashboard user ──POST /api/player──▶ Redis pub/sub ──▶ apps/bot (live control)
```

- PostgreSQL is the system of record (users, guilds, settings, queues,
  playlists, history, premium, sessions).
- Redis carries ephemera: rate limits, cooldowns, caches, and the
  dashboard→bot command channel. Optional in development; required in
  production.
- The bot's in-memory queue is authoritative while playing; it persists to
  PostgreSQL with a short debounce so the dashboard stays fresh.

## Rules

- Configuration is read only through `@discord-music/shared/env` (lint-enforced).
- Errors crossing any boundary are `AppError`s with stable codes.
- Guild authorization = Discord Manage Server ∩ bot present, checked in one
  place per app (web: `requireManagedGuild`; bot: guard pipeline).
