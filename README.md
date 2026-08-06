# Discord Music Platform

Production-grade Discord music platform: a Next.js 15 dashboard, a Discord bot
with Lavalink playback, Discord OAuth2 authentication and PostgreSQL.

Development follows the phased process in [`docs/ROADMAP.md`](docs/ROADMAP.md) —
one phase at a time, each approved before the next begins.

| Phase | Scope     | Status      |
| ----- | --------- | ----------- |
| 1     | Setup     | ✅ Complete |
| 2     | Auth      | ✅ Complete |
| 3     | Bot       | ✅ Complete |
| 4     | Music     | ✅ Complete |
| 5     | Dashboard | ✅ Complete |

See [CHANGELOG.md](CHANGELOG.md) for what shipped in each phase and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the deployment checklist.

## Requirements

- **Node.js** ≥ 20.11 (this repo is developed on the version in [`.nvmrc`](.nvmrc))
- **pnpm** 10 — `corepack enable pnpm`
- **Docker** — for local PostgreSQL, Redis and Lavalink

## Getting started

```bash
pnpm install                 # install workspace dependencies
cp .env.example .env         # then fill in the Discord credentials
pnpm run docker:up           # start PostgreSQL, Redis and Lavalink
pnpm run check:env           # verify every variable before starting anything
pnpm run db:generate         # generate the Prisma client
pnpm run db:migrate          # create and apply the initial migration
pnpm run dev                 # run the web app and bot together
```

The dashboard is served at <http://localhost:3000>; `/api/health` reports whether
PostgreSQL and Redis are reachable.

### Discord credentials

Create an application at <https://discord.com/developers/applications>, then:

- **OAuth2 → General**: copy the client ID and secret into `DISCORD_CLIENT_ID`
  and `DISCORD_CLIENT_SECRET`, and add `http://localhost:3000/api/auth/callback/discord`
  as a redirect URI (used from Phase 2).
- **Bot**: copy the token into `BOT_TOKEN`, and the application ID and public key
  into `BOT_CLIENT_ID` and `BOT_PUBLIC_KEY`.
- Set `BOT_DEV_GUILD_ID` to a test server ID so slash commands register instantly
  instead of taking up to an hour to propagate globally.

`NEXTAUTH_SECRET` can be generated with `openssl rand -base64 32`.

## Repository layout

```
.
├── apps/
│   ├── bot/                    Discord bot (discord.js, Shoukaku)
│   └── web/                    Next.js 15 dashboard (App Router)
├── packages/
│   ├── database/               Prisma schema, migrations, client singleton
│   └── shared/                 Types, validation, errors, env, logging, Redis
├── docker/                     Local PostgreSQL, Redis and Lavalink
├── docs/                       Architecture and process documentation
└── scripts/                    Repository maintenance scripts
```

See [`docs/FOLDER_STRUCTURE.md`](docs/FOLDER_STRUCTURE.md) for the full tree.

## Commands

Run from the repository root; Turborepo fans each task out across the workspace.

| Command              | Description                                        |
| -------------------- | -------------------------------------------------- |
| `pnpm run dev`       | Run every app in watch mode                        |
| `pnpm run build`     | Build every package and app                        |
| `pnpm run check`     | Format check, lint, typecheck and unit tests       |
| `pnpm run lint`      | ESLint across the workspace                        |
| `pnpm run typecheck` | `tsc --noEmit` across the workspace                |
| `pnpm run test`      | Vitest unit tests                                  |
| `pnpm run test:e2e`  | Playwright end-to-end tests                        |
| `pnpm run format`    | Rewrite files with Prettier                        |
| `pnpm run check:env` | Validate `.env` against every runtime's schema     |
| `pnpm run db:*`      | Prisma: `generate`, `migrate`, `push`, `studio`, … |
| `pnpm run docker:*`  | `up`, `down`, `logs` for local infrastructure      |

Target a single package with `--filter`:

```bash
pnpm --filter @discord-music/bot run dev
pnpm --filter @discord-music/bot run commands:deploy
```

## Conventions

- **Strict TypeScript** everywhere — see [`tsconfig.base.json`](tsconfig.base.json).
- **PascalCase** components, **camelCase** functions, **kebab-case** folders and
  files ([`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md)).
- Environment variables are read **only** through `@discord-music/shared/env`;
  an ESLint rule fails the build on direct `process.env` access.
- Errors crossing a boundary are `AppError` subclasses, so every HTTP response
  and Discord reply carries a stable code and a safe message.
- Commit hooks run `lint-staged`; CI runs the full `check` plus a build.
