# Self-hosting rollout checklist

Each checked repository checkpoint is verified, committed on `main`, and pushed
to `origin/main` before the next one begins. Never commit `.env`, database dumps,
Redis data, Funnel credentials, or backup encryption keys.

- [x] 1. Start isolated local PostgreSQL and Redis; apply Prisma migrations.
- [x] 2. Run the production web app and secret-gated gateway in Docker.
- [x] 3. Vercel forwards through authenticated Tailscale Funnel. Its public
      health response matches the PC backend; direct Funnel access returns 403.
      Remove the now-unused live Supabase and Upstash variables from Vercel
      when account access is available, then redeploy and recheck.
- [x] 4. Supabase data is restored with matching counts and history samples;
      all seven bot containers use local `postgres` and `redis` and report
      their dependencies healthy.
- [ ] 5. Complete PC acceptance tests, including multi-bot playback. Public
      pages/assets, unsigned interaction denial, and service restart recovery
      passed. Interactive OAuth, slash commands, buttons, and voice playback
      remain to be checked with a Discord account.
- [ ] 6. Document and rehearse the PC-to-VPS cutover.
- [ ] 7. Add backups, retention checks, and a restore drill.

The public Discord interactions and OAuth URLs remain on Vercel. Tailscale
Funnel exposes only the gateway; PostgreSQL, Redis, Lavalink, and raw Next.js
ports must not be forwarded from a router or VPS firewall.
