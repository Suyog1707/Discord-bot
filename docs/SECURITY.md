# Security

Rate limiting, CSRF, XSS protection, validation, authorization.

## The interactions endpoint

`POST /api/discord/interactions` is a public URL with no session behind it. The
only thing separating a genuine slash command from a forgery is an Ed25519
signature over the exact request body, checked before anything looks at the
payload (`apps/web/src/lib/discord/verify-signature.ts`).

Three rules that are easy to break and expensive to break:

- **The raw body is read first.** A request body is a one-shot stream, and the
  signature covers the bytes Discord sent — parsing and re-serialising produces
  different bytes and every signature fails.
- **A bad signature is a 401, not a 400.** Discord probes the endpoint with
  deliberately-invalid signatures when the URL is saved and refuses the URL
  unless they are rejected with 401.
- **No key, no service.** With `BOT_PUBLIC_KEY` unset the route answers 503
  rather than serving unverified requests.

## Secrets on Vercel

The dashboard holds `DATABASE_URL`, `REDIS_URL` and — since the command router
moved there — `BOT_TOKEN`.

The bot token is used for exactly one call: `GET /guilds/{id}/voice-states/{user}`,
which answers "which voice channel is the caller standing in?". The interaction
payload does not carry that and nothing else can supply it.

This is a genuine widening of what a compromise of the web deployment would
reach: that token can control the bot, not merely read the database. It is
recorded here rather than left implicit. `BOT_TOKEN` is in the logger's
redaction list (`packages/shared/src/logger/index.ts`), as are `token`,
`secret` and the `authorization` header, so it cannot reach a log line by
accident.
