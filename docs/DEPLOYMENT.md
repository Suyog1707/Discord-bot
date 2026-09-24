# Deployment

Current public route: Vercel still handles web requests directly until the
local Funnel proxy is explicitly enabled. The PC now has a private web backend,
PostgreSQL, and Redis; the same stack can later move to a VPS.

## Domain-free PC-to-Vercel proxy (staged, opt-in)

The PC's Docker gateway listens only at `127.0.0.1:20900`. Requests without
its `X-Origin-Secret` header return 403; raw Next.js, PostgreSQL, and Redis
have no public ports. Tailscale Funnel provides the HTTPS hostname without
router port forwarding. Funnel itself is public, so the gateway secret is
required even while Tailscale is running.

1. Check the local gateway: `pnpm docker:up`, then
   `curl -i http://127.0.0.1:20900/api/health` must return 403. The protected
   health check must report both database and Redis up.
2. On the **PC host**, start and sign in to Tailscale if needed. Enable HTTPS
   and Funnel in the tailnet admin console, then run
   `sudo tailscale funnel --bg 20900`. Run `tailscale funnel status` and copy
   the HTTPS `*.ts.net` URL. Do not forward port 20900 on your router.
3. In Vercel → Project → Settings → Environment Variables, set Production
   `BACKEND_PROXY_URL` to that HTTPS URL, `ORIGIN_SECRET` to the same private
   value in the PC's ignored `.env`, and `BACKEND_PROXY_ENABLED=true`. Do not
   prefix the secret with `NEXT_PUBLIC_`. Redeploy Production: environment
   changes do not modify existing deployments.
4. The middleware forwards **all** routes to the local web backend only when
   that flag is true on Vercel. Missing URL or secret returns 503. Test the
   public Vercel website, OAuth, `/api/health`, and Discord interactions.
   A direct visit to the Funnel hostname without the secret must return 403.
   Keep `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, Discord's Interactions Endpoint
   URL, and OAuth callback on the public Vercel domain.
5. Once the proxy is verified, remove live `DATABASE_URL`, `DIRECT_URL`,
   `REDIS_URL`, and bot/OAuth secrets from Vercel and redeploy. The Vercel build
   must remain a workspace build; Prisma client generation does not require a
   working database. The PC's backend retains the runtime secrets.

To roll back routing temporarily, set `BACKEND_PROXY_ENABLED=false` in Vercel
and redeploy. That restores the old Vercel execution path, which requires the
old external providers; do not use it after those providers are retired.

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
3. **Web (Vercel)** — root directory `apps/web`. The build command lives in
   `apps/web/vercel.json` and must stay a workspace build, not a bare
   `next build`: the app imports `@discord-music/shared` and
   `@discord-music/database` through their `exports`, which point at `dist/`,
   and Vercel never builds a workspace dependency on its own. A plain
   `next build` therefore fails at webpack resolution — "Module not found" for
   both packages. Routing it through Turborepo builds them first
   (`--filter=@discord-music/web...`, where the trailing `...` means "and its
   dependencies"), which is also what runs `prisma generate`, so the client
   cannot go stale behind Vercel's dependency cache.
   Set every `NEXT*`, `DISCORD_*`, `DATABASE_URL`, `REDIS_URL` variable.
   `DIRECT_URL` is only needed where migrations run; the build itself only
   generates the client and falls back to `DATABASE_URL` without it.
   Add the production callback URL in the Discord developer portal:
   `https://<domain>/api/auth/callback/discord`.

   The web app also hosts the **command router** — Discord posts every slash
   command to `POST /api/discord/interactions` rather than sending it down a
   bot's gateway connection — so it needs two variables that used to belong
   only to the bot:

   - `BOT_PUBLIC_KEY` — the command application's public key. Without it the
     route refuses to serve at all (503), because an endpoint that cannot check
     signatures is one anybody can drive.
   - `BOT_TOKEN` — used for exactly one call, asking Discord which voice
     channel the caller is standing in. The interaction payload does not carry
     it and there is no other way to find out. This is a real widening of what
     a Vercel compromise would reach; see docs/SECURITY.md.

   Turn on **Fluid compute** for the project. Autocomplete is the one path with
   no deferral to hide behind — it must answer inside three seconds — and cold
   starts are what threaten it.

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

7. **Recommendations (optional)** — `GROQ_API_KEY` enables natural-language
   `/ask` parsing (without it a keyword parser handles it), and
   `LASTFM_API_KEY` enables the similarity graph that autoplay's _discovery_
   slots and `/ask` draw candidates from (without it autoplay still plays the
   listener's own library, playlists and history, just with no discoveries).
   MusicBrainz needs no key and supplies canonical artist identity plus the tags
   that drive language matching; `MUSICBRAINZ_ENABLED=false` is a kill switch
   for its one-request-per-second limit. None of these are required to play
   music — each degrades on its own.

## Notes

- Web and bot share one `DATABASE_URL`/`REDIS_URL` so live control and queue
  views line up. Neither ever opens `DIRECT_URL` — the Prisma client is
  constructed with `DATABASE_URL` explicitly, and only the `db:*` CLI scripts
  use the direct connection.
- The bot refuses to boot in production if any dependency is unreachable —
  fix the dependency rather than downgrading NODE_ENV.

## Switching commands to the router

Discord delivers an application's interactions either down its gateway
connection or to an HTTPS endpoint — never both. Setting the endpoint moves
_all_ of them: commands, buttons and menus alike.

Do it once, on the command application only. The player applications keep their
gateways and are untouched.

1. Confirm the router answers. Discord validates the URL by sending a PING and
   a handful of deliberately-invalid signatures; it will refuse the URL unless
   the bad ones come back 401.
2. Developer portal → the command application → General Information →
   **Interactions Endpoint URL** → `https://<domain>/api/discord/interactions`
   → Save.
3. Check a command in each server. Player containers should start logging
   commands they have never seen before (`"routed": true`).
4. Check a controller button, and `/spotify playlists` if Spotify tokens are
   configured — those are the two paths that change shape, not just address.

### Rolling back

**Clear the Interactions Endpoint URL.** Commands resume over the gateway
within seconds, with no deploy and no restart.

That works because the gateway path is never removed: the bots still need it
for voice, for guild events, and for the components of every message a _player_
posts. Rehearse it once so it is a known move rather than a thing to work out
under pressure.

**What rolling back costs.** Commands come back, but single-room only. The
layer that let one bot hand a channel to another was removed once the router
had proved itself, so on the gateway path the main bot receives everything and
has no way to pass a second channel to a sibling. A server already playing in
two channels keeps both — nothing disconnects — but a _new_ second room cannot
be started until the endpoint URL is restored.

That is a deliberate trade: keeping a parallel hand-off mechanism alive forever,
to insure against a switch that flips back in seconds, is a standing
maintenance cost for a momentary one.

The failure it covers is real and worth naming: with the endpoint set, an
outage of the web deployment takes down every slash command in every server.
Before, the same was true of the primary bot container. The blast radius has
not grown, but it has moved somewhere else, and this is the lever.
