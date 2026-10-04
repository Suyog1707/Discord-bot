# PC → Ubuntu/Debian VPS cutover

The PC is the tested deployment. Do not run the VPS bots with the same Discord
tokens until the PC bots are stopped. The public Vercel URL and Discord URLs
remain unchanged; only Vercel's `BACKEND_PROXY_URL` moves from the PC Funnel
hostname to the VPS Funnel hostname.

## 1. Prepare the VPS (no production tokens yet)

Use an Ubuntu/Debian VPS with enough memory for seven bots, PostgreSQL, Redis,
Next.js, and Lavalink. Add an SSH key at provisioning. Apply security updates,
create a non-root deploy user, and disable password SSH after confirming key
login works in a second terminal. Allow only the actual SSH port in the VPS
provider firewall and UFW. Do **not** open or forward 20001, 20002, 20003,
or 20900. Funnel makes an outbound connection; the gateway binds to loopback.
Docker-published ports can bypass some UFW rules, so verify the Compose
`host_ip` values are `127.0.0.1` before starting.

The bot publishes PostgreSQL on 20001, Redis on 20002, Lavalink on 20003,
and the authenticated gateway on 20900, all loopback-only. Set
`POSTGRES_PORT=20001`, `REDIS_PORT=20002`, and `LAVALINK_PORT=20003` in an
existing private `.env`; update host-side database/Redis URLs to those ports.
Check `sudo ss -ltnp` before starting: other VPS applications can still occupy
these ports. Internal Docker ports remain unchanged and do not conflict with
host services. Do not change the VPS SSH port as part of this deployment.

Install Docker Engine and the Compose plugin from the [official Docker apt
instructions](https://docs.docker.com/engine/install/ubuntu/) (use the
[Debian variant](https://docs.docker.com/engine/install/debian/) on Debian).
Verify `docker compose version` and `sudo docker run hello-world`. The Docker
group grants root-equivalent access; either use `sudo docker` or add only the
trusted deploy account to that group. Install Tailscale from its
[Linux instructions](https://tailscale.com/docs/install/linux), run
`sudo tailscale up`, and confirm the VPS appears in the same tailnet as the PC.
Install Git; Node/pnpm are optional on the VPS because Compose builds the apps.

Clone `main` into a private directory owned by the deploy user. Create `.env`
from `.env.example` there, with the **same application tokens and OAuth secrets**
but **new** `POSTGRES_PASSWORD` and `REDIS_PASSWORD` (`openssl rand -hex 32` for
each). Keep `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` on the existing Vercel URL.
Set `COMPOSE_PROFILES=` initially so no player bots start during restore. Never
copy the PC `.env` into Git or put its contents in a shell command history.

## 2. Rehearse a restore before stopping the PC

Use a private copy of the PC dump to rehearse on a disposable VPS database
before the actual cutover. `docker compose --env-file .env -f
docker/docker-compose.yml config --quiet` must succeed. Start only the data
services and migrations:

```sh
docker compose --env-file .env -f docker/docker-compose.yml up -d postgres redis postgres-migrate
docker compose --env-file .env -f docker/docker-compose.yml ps
```

The restore procedure below is **data-only** because Prisma creates the schema
on the destination. Do not restore Supabase roles, extensions, RLS settings, or
old Redis presence/claims/command queues. Compare counts and sample history
against the PC. Keep rehearsal and production credentials separate if using a
separate rehearsal VPS or Docker project; never overwrite the tested PC volume.

## 3. Final write freeze and transfer

Schedule a short outage. Stop the PC bots and web writes, including all player
profiles, before the final dump. Do not stop PostgreSQL itself:

```sh
docker compose --env-file .env -f docker/docker-compose.yml stop \
  bot-main bot-player-2 bot-player-3 bot-player-4 bot-player-5 bot-player-6 bot-player-7 \
  web-backend web-gateway
```

Take a fresh `pg_dump` of **public data only** with the backup script in this
repository, or run `pg_dump --format=custom --schema=public --data-only` inside
the PC PostgreSQL container. Keep the file mode 0600 in a mode-0700 directory
outside Git. Record a SHA-256 checksum, and transfer over SSH to the VPS
Tailscale IP/name with `scp`; verify the checksum on both ends. Do not delete
the PC dump or Supabase export. The Vercel site may return 503 during the
write freeze; this is safer than split-brain writes.

## 4. Restore the final dump on the VPS

With only VPS PostgreSQL, Redis, and migrations running, verify the destination
contains no user records. Prisma's 17 migration rows already exist, so clear
only their duplicate log before streaming the data-only dump. Substitute the
private dump path below:

```sh
docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres \
  sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "TRUNCATE TABLE public._prisma_migrations"'

docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres \
  sh -c 'pg_restore --data-only --disable-triggers --single-transaction \
  --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /private/path/final-public-data.dump

docker compose --env-file .env -f docker/docker-compose.yml run --rm postgres-migrate
```

If restore fails, do not start bots. Use a new empty destination database and
repeat; never replay a partial dump into a database already serving traffic.
Compare exact counts for all public tables and a few sample history rows with
the frozen PC source. Start Redis empty.

## 5. Start, route, and validate

Set `COMPOSE_PROFILES=players` only for player identities with complete token
and client ID pairs, then run `docker compose --env-file .env -f
docker/docker-compose.yml up -d --build`. Verify all bot health checks, local
PostgreSQL and Redis, and a 403 from `http://127.0.0.1:20900/api/health`
without `X-Origin-Secret`. The authenticated request must report both
dependencies up. Start a persistent [Tailscale
Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel) on the VPS:

```sh
sudo tailscale funnel --bg 20900
tailscale funnel status
```

In Vercel Production, change only `BACKEND_PROXY_URL` to the **VPS** HTTPS
`.ts.net` URL and redeploy. Keep the same `ORIGIN_SECRET` as the VPS gateway
and keep `NEXTAUTH_URL`, OAuth callback, and Discord Interactions Endpoint URL
on the public Vercel domain. Remove Supabase/Upstash credentials from Vercel
after the new route is verified. Compare `/api/health` uptime through Vercel
with the VPS backend; test login, dashboard, commands, buttons, playback in
multiple channels, and all player bots. A direct Funnel URL without the secret
must still return 403. Leave the PC stack stopped until stable.

## Rollback

If the VPS fails, **stop every VPS bot and web write first**. Change Vercel's
`BACKEND_PROXY_URL` back to the PC Funnel URL and redeploy, then restart the PC
stack. Never run both sets of bots with the same tokens at once. If the VPS
accepted writes before rollback, export those writes and reconcile them before
returning to the PC; blindly switching back loses them.
