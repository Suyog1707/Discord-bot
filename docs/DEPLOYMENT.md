# Deployment

Targets: Web → Vercel · Bot + Lavalink → VPS · PostgreSQL → managed · Redis → Upstash.

## Checklist

1. **Secrets** — set all variables from `.env.example`. Verify with
   `pnpm run check:env:prod` (Redis + Lavalink are mandatory in production).
2. **Database** — `pnpm run db:deploy` applies committed migrations.
3. **Web (Vercel)** — root directory `apps/web`; build runs `next build`.
   Set every `NEXT*`, `DISCORD_*`, `DATABASE_URL`, `REDIS_URL` variable.
   Add the production callback URL in the Discord developer portal:
   `https://<domain>/api/auth/callback/discord`.
4. **Lavalink (VPS)** — run `docker/lavalink/application.yml` with a strong
   `LAVALINK_PASSWORD`; keep port 2333 firewalled to the bot host only.
5. **Bot (VPS)** — build `apps/bot/Dockerfile` from the repo root; run with
   `NODE_ENV=production` and the full env. Deploy slash commands once:
   `pnpm --filter @discord-music/bot run commands:deploy` (unset
   `BOT_DEV_GUILD_ID` for global registration).
6. **Monitoring** — point uptime checks at `/api/health` (503 = required
   dependency down); ship pino JSON logs from the bot host.

## Notes

- Web and bot share one `DATABASE_URL`/`REDIS_URL` so live control and queue
  views line up.
- The bot refuses to boot in production if any dependency is unreachable —
  fix the dependency rather than downgrading NODE_ENV.
