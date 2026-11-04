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
   During migration, stop the primary bot with
   `docker compose --env-file .env -f docker/docker-compose.yml stop bot-main`
   until the Vercel proxy is live. `pnpm docker:up` starts it again, so repeat
   the stop if you rerun that command before cutover. This prevents Discord
   activity writing to local PostgreSQL while Vercel still uses the old one.
2. On the **PC host**, start and sign in to Tailscale if needed. Enable HTTPS
   and Funnel in the tailnet admin console, then run
   `sudo tailscale funnel --bg 20900`. Run `tailscale funnel status` and copy
   the HTTPS `*.ts.net` URL. Do not forward port 20900 on your router.
3. In Vercel → Project → Settings → Environment Variables, set Production
   `BACKEND_PROXY_URL` to that HTTPS URL, `ORIGIN_SECRET` to the same private
   value in the PC's ignored `.env`, and `BACKEND_PROXY_ENABLED=true`. Do not
   add `WEB_BACKEND_LOCAL` to Vercel or prefix the secret with `NEXT_PUBLIC_`.
   Redeploy Production: environment changes do not modify existing deployments.
4. The middleware forwards **all** routes to the local web backend only when
   that flag is true on Vercel. Missing URL or secret returns 503. Test the
   public Vercel website, OAuth, `/api/health`, and Discord interactions.
   A direct visit to the Funnel hostname without the secret must return 403.
   Keep `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, Discord's Interactions Endpoint
   URL, and OAuth callback on the public Vercel domain.
   Only after that verification, start the primary bot with
   `docker compose --env-file .env -f docker/docker-compose.yml start bot-main`.
5. Once the proxy is verified, remove live `DATABASE_URL`, `DIRECT_URL`,
   `REDIS_URL`, and bot/OAuth secrets from Vercel and redeploy. The Vercel build
   must remain a workspace build; Prisma client generation does not require a
   working database. The PC's backend retains the runtime secrets.

If Vercel's proxy flag or secret is missing, requests fail with 503 instead of
falling back to Supabase or Upstash. To roll back to the PC from the VPS, stop
VPS bots and writes, point `BACKEND_PROXY_URL` at the PC Funnel URL, and
redeploy; do not disable the proxy flag.

## Checklist

1. **Secrets** — set all variables from `.env.example`. Verify with
   `pnpm run check:env:prod` (Redis + Lavalink are mandatory in production).
2. **Database** — `pnpm docker:up` starts local PostgreSQL and runs committed
   Prisma migrations before the web backend or bots start. For host-side CLI
   commands, `DATABASE_URL` and `DIRECT_URL` both point to the loopback Docker
   port. Keep the private database dump until the VPS restore is verified.
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
   The Vercel runtime should hold only the Funnel proxy URL and origin secret,
   plus public build-time values. Do not put live database, Redis, bot, or OAuth
   credentials there after the proxy is active.
   Add the production callback URL in the Discord developer portal:
   `https://<domain>/api/auth/callback/discord`.

   The Docker web backend hosts the **command router** — Discord posts every
   slash command to `POST /api/discord/interactions` via the public Vercel URL.
   The backend, not Vercel, needs:

   - `BOT_PUBLIC_KEY` — the command application's public key. Without it the
     route refuses to serve at all (503), because an endpoint that cannot check
     signatures is one anybody can drive.
   - `BOT_TOKEN` — used to ask Discord which voice channel the caller is in.

   Turn on **Fluid compute** for the project. Autocomplete is the one path with
   no deferral to hide behind — it must answer inside three seconds — and cold
   starts are what threaten it.

4. **Lavalink (PC, then VPS)** — use a strong `LAVALINK_PASSWORD`; host port 20003
   binds to loopback only and must not be forwarded. Deploy
   the `yt-cipher` sidecar alongside it (it is in `docker/docker-compose.yml`)
   and leave it unpublished — Lavalink reaches it as `http://yt-cipher:8001` to
   decipher YouTube stream signatures. Without it, YouTube playback fails with
   `Must find sig function from script`. Keep the `youtube-plugin` version in
   `application.yml` current: the startup log prints a notice when a newer
   release exists, and YouTube regularly breaks older ones.
5. **Bots (PC, then VPS)** — Compose builds and runs the primary bot and any
   configured player profiles with Docker-internal PostgreSQL and Redis URLs.
   Deploy slash commands once:
   `pnpm --filter @discord-music/bot run commands:deploy` (unset
   `BOT_DEV_GUILD_ID` for global registration).
6. **Monitoring** — check `/api/health` through Vercel (503 = required
   dependency down); ship pino JSON logs from the bot host. Never publish the
   origin secret in a public uptime-check configuration.

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

- Web and bots share the private Docker PostgreSQL and Redis services so live
  control and queue views line up. `DIRECT_URL` is for migration CLI commands.
- The bot refuses to boot in production if any dependency is unreachable —
  fix the dependency rather than downgrading NODE_ENV.

## How commands reach the fleet

Discord delivers an application's interactions either down its gateway
connection or to an HTTPS endpoint — never both, and setting the endpoint moves
_all_ of them: commands, buttons and menus alike. Both modes route to the whole
fleet, over the same Redis queues, with the same decision (`routeInteraction`).

### Recommended: gateway (Interactions Endpoint URL cleared)

**Leave the Interactions Endpoint URL empty** (developer portal → the command
application → General Information). Main receives commands over its own
gateway within milliseconds, acknowledges them locally, picks the bot for the
caller's voice channel and pushes the command onto that bot's queue — its own
included — where each bot's interaction subscriber runs it. Multi-room routing
is kept. The player applications keep their gateways and are untouched.

Why this is the recommended mode: through Vercel and a Tailscale Funnel,
commands reached the VPS 2.8–40 s after Discord created them (Funnel's TLS
relay alone took 1.2–6 s). Discord's window is 3 s, so people saw "application
did not respond" and `10015 Unknown Webhook`, while the bots themselves took
about 50 ms. The gateway path removes the relay entirely.

Requirements and limits:

- Main needs Redis. Without Redis, or when a command's raw payload was not
  captured, main runs the command locally — single-room, as before routing
  existed.
- Main must be up for commands to work. That is the same blast radius as
  before an endpoint was ever set.

### Alternative: HTTP router (Interactions Endpoint URL set)

Still supported; the web router is unchanged. Do it once, on the command
application only.

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

Use this only if the relay path is fast enough for your deployment; if commands
start timing out, go back to the gateway.

### Rolling back

**Clear the Interactions Endpoint URL.** Commands resume over the gateway
within seconds, with no deploy and no restart, and now keep multi-room routing:
main routes them to the fleet exactly as the web router does. Rehearse it once
so it is a known move rather than a thing to work out under pressure.

The same switch works the other way: setting the URL moves everything back to
the web router. Nothing disconnects either way.

The failure the HTTP mode adds is real and worth naming: with the endpoint set,
an outage of the web deployment takes down every slash command in every server.
In gateway mode the same is true of the primary bot container instead. Pick the
one whose outage you would rather have, and keep the switch in mind as the lever.

## Own Tailscale Funnel for the website (replaces the host Funnel)

The website path is browser -> Vercel (middleware rewrite to
`BACKEND_PROXY_URL`) -> Tailscale Funnel -> `web-gateway`. The Funnel on the
VPS host's tailscaled belongs to the company tailnet and is congested: TLS
handshakes take 12-31 s or fail, so Vercel returns 502
`ROUTER_EXTERNAL_TARGET_HANDSHAKE_ERROR`. Instead, the `tailscale-funnel`
service runs a separate Tailscale node in a container, joined to a personal
tailnet, in userspace mode (no host network changes, no contact with the host's
tailscaled). It serves its own Funnel straight to `web-gateway:8080` over the
compose network.

1. In the **personal** Tailscale admin console (login.tailscale.com):
   - DNS: enable MagicDNS and HTTPS Certificates.
   - Access controls: make sure the policy grants the `funnel` node attribute,
     e.g. `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`
     (the default policy usually has it).
   - Settings -> Keys: generate an auth key (not reusable, not ephemeral).
2. On the VPS, in `/root/Discord-bot/.env`, set `TS_AUTHKEY=...` and
   `COMPOSE_PROFILES=players,funnel`.
3. Start it, then read the URL:

   ```bash
   docker compose --env-file .env -f docker/docker-compose.yml up -d tailscale-funnel
   docker logs dmp-tailscale
   docker exec dmp-tailscale tailscale funnel status
   ```

4. Test from anywhere (403 is correct without the secret; it should be fast):

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{time_appconnect}\n' https://tesseract-web.<tailnet>.ts.net/api/health
   ```

5. In Vercel, set `BACKEND_PROXY_URL` to that URL and Redeploy.
6. Leave the company host's own Funnel config alone; it is not ours to change.

The security model is unchanged: the gateway still requires `X-Origin-Secret`,
and only Vercel knows it. The auth key is only needed for the first login; the
node state lives in the `tailscale-state` volume.
