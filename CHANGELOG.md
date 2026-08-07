# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); the project is pre-release, so
everything lives under 0.1.0 until the first deploy.

## 0.1.0 (unreleased)

### Removed

- The entire premium system, before it ever gated anything: the `Premium`
  model and `PremiumTier` enum (dropped by migration `remove_premium`), the
  `PREMIUM_REDEEM` verification type, the dashboard Premium page and plan
  card, and the tier field on `GET /api/user`. Every feature is available to
  every user; the playlist cap is now a single abuse guard of 250 for
  everyone (previously 25 free / 250 premium).

### Fixed

- Lavalink never started: the image ships no `/opt/Lavalink/plugins`, so Docker
  created the named volume owned by root while the server runs as uid 322 and
  its plugin downloads failed with "Permission denied", crash-looping before it
  could bind port 2333. A `lavalink-init` service now claims the volume first,
  repairing volumes left root-owned by earlier runs.
- The bot no longer stays mute for the rest of the process when Lavalink is slow
  to boot. Shoukaku deletes a node from the pool once `reconnectTries` is
  exhausted and never retries it; a supervisor now probes the REST API every 30s
  and re-adds the node when it answers. Probing first also sidesteps a Shoukaku
  4.3.0 bug that discards a retry succeeding after an earlier failure.
- Unreachable-host errors are logged as one compact line (code, address, port,
  reason) instead of an `AggregateError` stack wall, and exhausting the retries
  now logs what broke and how to fix it rather than falling silent.

### Phase 5 — Dashboard

- Full dashboard: servers grid with invite links, server detail with live
  queue view + player controls + settings form, playlists CRUD, analytics
  (30-day plays, top tracks, skip rate), account settings with session
  revocation.
- REST API under `/api` (user, server, player, playlist, music, settings)
  with a uniform response envelope, per-user rate limiting and Zod validation
  on every input.
- Live player control from the dashboard to the bot over Redis pub/sub, with
  the message schema shared and validated on both ends.
- Production Content-Security-Policy plus the Phase-1 security header set.

### Phase 4 — Music

- Lavalink v4 playback via Shoukaku: per-guild players, queue engine with
  loop/shuffle semantics, track resolution for URLs and searches
  (YouTube/SoundCloud, Spotify/Deezer via Lavalink plugins).
- Slash commands: play, skip, stop, pause, resume, volume, seek, nowplaying,
  disconnect, queue, shuffle, loop, remove, clear.
- Queue persistence to PostgreSQL (powers the dashboard queue view) and
  SongHistory recording (powers analytics).
- Idle auto-leave driven by voice-channel occupancy and per-guild timeout.

### Phase 3 — Bot core

- Guard pipeline: guild-only, user/bot permissions, per-user cooldowns
  (Redis-backed with in-memory fallback), DJ role.
- Guild lifecycle persistence with settings retention across re-invites.
- Commands: help, stats, settings (volume / dj-role / announce / auto-leave).

### Phase 2 — Authentication

- Discord OAuth2 via Auth.js v5 with database sessions and the Prisma
  adapter; sessions are revocable from the dashboard.
- Discord API client with automatic access-token refresh.
- Protected dashboard shell with middleware fast-path and server-side
  authoritative session checks.

### Phase 1 — Setup

- pnpm + Turborepo monorepo: `apps/web`, `apps/bot`, `packages/shared`,
  `packages/database`.
- Strict TypeScript, shared ESLint flat config, Prettier, Vitest, Playwright,
  husky + lint-staged, GitHub Actions CI.
- Prisma schema and initial migration; Docker Compose for PostgreSQL, Redis
  and Lavalink.
- Environment validation with per-runtime schemas; Redis/Lavalink optional in
  development, required in production. PostgreSQL reachability is advisory in
  development.
