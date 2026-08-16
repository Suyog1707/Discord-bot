# Deployment

Targets: Web → Vercel · Bot + Lavalink → VPS · PostgreSQL → managed · Redis → Upstash.

## Checklist

1. **Secrets** — set all variables from `.env.example`. Verify with
   `pnpm run check:env:prod` (Redis + Lavalink are mandatory in production).
2. **Database** — `pnpm run db:deploy` applies committed migrations. It connects
   through `DIRECT_URL`, not `DATABASE_URL`: migrations need DDL, advisory locks
   and a shadow database, none of which survive a transaction pooler. On
   Supabase that is the direct connection (`db.<ref>.supabase.co:5432`) or the
   session pooler (`…pooler.supabase.com:5432`) — prefer the session pooler,
   since the direct host is IPv6-only unless the IPv4 add-on is enabled.
   `DATABASE_URL` stays on the transaction pooler (`:6543?pgbouncer=true`) and
   serves every runtime query.
3. **Web (Vercel)** — root directory `apps/web`; build runs `next build`.
   Set every `NEXT*`, `DISCORD_*`, `DATABASE_URL`, `REDIS_URL` variable.
   `DIRECT_URL` is only needed where migrations run; the build itself only
   generates the client and falls back to `DATABASE_URL` without it.
   Add the production callback URL in the Discord developer portal:
   `https://<domain>/api/auth/callback/discord`.
4. **Lavalink (VPS)** — run `docker/lavalink/application.yml` with a strong
   `LAVALINK_PASSWORD`; keep port 2333 firewalled to the bot host only. Deploy
   the `yt-cipher` sidecar alongside it (it is in `docker/docker-compose.yml`)
   and leave it unpublished — Lavalink reaches it as `http://yt-cipher:8001` to
   decipher YouTube stream signatures. Without it, YouTube playback fails with
   `Must find sig function from script`. Keep the `youtube-plugin` version in
   `application.yml` current: the startup log prints a notice when a newer
   release exists, and YouTube regularly breaks older ones.
5. **Bot (VPS)** — build `apps/bot/Dockerfile` from the repo root; run with
   `NODE_ENV=production` and the full env. Deploy slash commands once:
   `pnpm --filter @discord-music/bot run commands:deploy` (unset
   `BOT_DEV_GUILD_ID` for global registration).
6. **Monitoring** — point uptime checks at `/api/health` (503 = required
   dependency down); ship pino JSON logs from the bot host.

## Notes

- Web and bot share one `DATABASE_URL`/`REDIS_URL` so live control and queue
  views line up. Neither ever opens `DIRECT_URL` — the Prisma client is
  constructed with `DATABASE_URL` explicitly, and only the `db:*` CLI scripts
  use the direct connection.
- The bot refuses to boot in production if any dependency is unreachable —
  fix the dependency rather than downgrading NODE_ENV.
