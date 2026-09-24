# Self-hosting rollout checklist

Each checked repository checkpoint is verified, committed on `main`, and pushed
to `origin/main` before the next one begins. Never commit `.env`, database dumps,
Redis data, Funnel credentials, or backup encryption keys.

- [x] 1. Start isolated local PostgreSQL and Redis; apply Prisma migrations.
- [x] 2. Run the production web app and secret-gated gateway in Docker.
- [ ] 3. Add opt-in Vercel forwarding through Tailscale Funnel. Proxy code and
      local gateway are ready; enabling Funnel and Vercel Production variables
      remains an operator checkpoint.
- [ ] 4. Restore and verify data, then switch every bot to local infrastructure.
      Supabase data is restored with matching counts and history samples; all
      bot Compose services now resolve `postgres` and `redis`. The primary bot
      stays stopped until Vercel is routed to this same local backend, avoiding
      simultaneous writes to different databases.
- [ ] 5. Complete PC acceptance tests, including multi-bot playback.
- [ ] 6. Document and rehearse the PC-to-VPS cutover.
- [ ] 7. Add backups, retention checks, and a restore drill.

The public Discord interactions and OAuth URLs remain on Vercel. Tailscale
Funnel exposes only the gateway; PostgreSQL, Redis, Lavalink, and raw Next.js
ports must not be forwarded from a router or VPS firewall.
