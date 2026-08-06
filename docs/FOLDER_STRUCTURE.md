# Folder Structure

Top level: `apps/`, `packages/`, `docs/`, `docker/`, `scripts/`.

```
discord-music-platform/
├── apps/
│   ├── bot/                          Discord bot
│   │   ├── src/
│   │   │   ├── commands/<category>/  One file per slash command; auto-discovered
│   │   │   ├── config/env.ts         Validated bot configuration
│   │   │   ├── core/                 Client, command/event contracts, registries
│   │   │   ├── events/               One file per gateway event; auto-discovered
│   │   │   ├── lib/                  Logger and cross-cutting helpers
│   │   │   ├── scripts/              Slash-command deployment
│   │   │   └── index.ts              Entry point, signal handling, shutdown
│   │   ├── Dockerfile                Multi-stage image for VPS deployment
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   └── web/                          Next.js 15 dashboard (App Router)
│       ├── e2e/                      Playwright specs
│       ├── src/
│       │   ├── app/                  Routes, layouts, error boundaries, /api
│       │   ├── components/ui/        shadcn/ui primitives
│       │   └── lib/                  env, db, redis, logger, API helpers, utils
│       ├── components.json           shadcn/ui configuration
│       ├── next.config.ts            Security headers, image hosts, transpilation
│       ├── playwright.config.ts
│       ├── postcss.config.mjs        Tailwind CSS v4
│       └── vitest.config.ts
│
├── packages/
│   ├── database/                     Prisma
│   │   ├── prisma/schema.prisma      Models, enums, indexes
│   │   ├── prisma/seed.ts            Idempotent development seed
│   │   └── src/                      Client singleton and error predicates
│   │
│   └── shared/                       Consumed by both apps
│       └── src/
│           ├── constants/            Limits, Redis namespaces, source enums
│           ├── env/                  Zod env schemas and loaders  (subpath: /env)
│           ├── errors/               AppError hierarchy and codes
│           ├── logger/               pino factory with redaction (subpath: /logger)
│           ├── redis/                ioredis factory and singleton (subpath: /redis)
│           ├── types/                Result, ApiResponse, Paginated, utilities
│           └── validation/           Reusable Zod primitives and parse helpers
│
├── docker/
│   ├── docker-compose.yml            PostgreSQL, Redis, Lavalink
│   └── lavalink/application.yml      Lavalink v4 + source plugins
│
├── docs/                             This documentation set
├── scripts/check-env.mjs             Validates .env against every runtime schema
│
├── eslint.config.mjs                 Shared flat config; packages re-export it
├── tsconfig.base.json                Strict compiler options for every package
├── turbo.json                        Task graph, caching, outputs
├── pnpm-workspace.yaml               Workspace globs
└── .env.example                      Every required variable
```

## Rules

- Folders and files are **kebab-case**; React components are **PascalCase**
  exports inside kebab-case files.
- `packages/shared` exposes Node-only modules (`env`, `logger`, `redis`) as
  subpath exports so importing the root barrel from a client component never
  pulls server code into the browser bundle.
- Bot commands and events are discovered from the filesystem — adding one is a
  single new file, with no central registry to update.
- Configuration lives only in `packages/shared/src/env`; nothing else reads
  `process.env`.
