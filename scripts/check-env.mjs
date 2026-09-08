#!/usr/bin/env node
/**
 * Validate `.env` against every runtime's schema before starting anything.
 *
 *   pnpm run check:env
 *
 * Reports problems for the web app and for every bot identity in a single
 * pass, so a fresh clone gets one complete list of what to fill in rather than
 * discovering missing variables one crash at a time.
 *
 * Exits 0 when every runtime validates, 1 otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(repoRoot, '.env');
const examplePath = join(repoRoot, '.env.example');

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** Minimal dotenv parser — avoids a dependency for a script that must run pre-install. */
function parseDotenv(contents) {
  /** @type {Record<string, string>} */
  const result = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Empty values are kept: `--env-file` sets them as empty strings, and the
    // schema decides whether blank means "unset".
    result[key] = value;
  }

  return result;
}

if (!existsSync(envPath)) {
  console.error(`${RED}✗${RESET} No .env file found at ${envPath}`);
  console.error(`  ${DIM}Run: cp .env.example .env${RESET}`);
  process.exit(1);
}

const env = { ...parseDotenv(readFileSync(envPath, 'utf8')) };

// Report keys documented in .env.example but absent from .env — likely a stale copy.
if (existsSync(examplePath)) {
  const documented = Object.keys(parseDotenv(readFileSync(examplePath, 'utf8')));
  const missing = documented.filter((key) => (env[key] ?? '') === '');
  if (missing.length > 0) {
    console.warn(`${YELLOW}!${RESET} Present in .env.example but unset in .env:`);
    for (const key of missing) console.warn(`  ${DIM}• ${key}${RESET}`);
    console.warn('');
  }
}

let schemas;
try {
  schemas = await import('@discord-music/shared/env');
} catch {
  console.error(`${RED}✗${RESET} Could not load @discord-music/shared/env.`);
  console.error(
    `  ${DIM}Run: pnpm install && pnpm --filter @discord-music/shared run build${RESET}`,
  );
  process.exit(1);
}

const { botEnvSchema, parseEnv, webEnvSchema } = schemas;

/**
 * Every bot identity configured here, primary first.
 *
 * Each container runs exactly ONE identity, so each is validated on its own
 * against the same schema — with its token and client id substituted in — and
 * a broken player is reported as a broken player rather than as a vague
 * complaint about the bot.
 *
 * Players are discovered from the variable names rather than counted, because
 * nothing else in this system knows how many bots there are either. Adding an
 * eighth means adding BOT_PLAYER_8_TOKEN and its client id; this script picks
 * it up with no change.
 */
function botIdentities(source) {
  const numbers = Object.keys(source)
    .map((key) => /^BOT_PLAYER_(\d+)_(?:TOKEN|CLIENT_ID)$/u.exec(key)?.[1])
    .filter((n) => n !== undefined)
    .map(Number)
    .filter(
      (n) =>
        (source[`BOT_PLAYER_${n}_TOKEN`] ?? '') !== '' ||
        (source[`BOT_PLAYER_${n}_CLIENT_ID`] ?? '') !== '',
    );

  const players = [...new Set(numbers)]
    .sort((a, b) => a - b)
    .map((n) => ({
      label: `apps/bot (player-${n})`,
      schema: botEnvSchema,
      source: {
        ...source,
        BOT_ROLE: 'player',
        BOT_LABEL: `player-${n}`,
        BOT_TOKEN: source[`BOT_PLAYER_${n}_TOKEN`] ?? '',
        BOT_CLIENT_ID: source[`BOT_PLAYER_${n}_CLIENT_ID`] ?? '',
      },
    }));

  return [
    { label: 'apps/web', schema: webEnvSchema, source },
    { label: 'apps/bot (main)', schema: botEnvSchema, source: { ...source, BOT_ROLE: 'primary' } },
    ...players,
  ];
}

/**
 * A player switched on in COMPOSE_PROFILES but never given an identity.
 *
 * Docker would start that container and `restart: always` would keep starting
 * it, each time failing on a blank token. Catching it here turns a silent
 * restart loop into one line of output before anything is launched.
 */
function unconfiguredProfiles(source) {
  const active = (source.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  return active
    .map((name) => /^player-(\d+)$/u.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .filter((n) => (source[`BOT_PLAYER_${n}_TOKEN`] ?? '') === '')
    .map((n) => `COMPOSE_PROFILES starts player-${n}, but BOT_PLAYER_${n}_TOKEN is not set`);
}

/**
 * Two containers sharing a token is the one misconfiguration this whole design
 * exists to prevent: Discord allows a single voice connection per guild per
 * token, so the second bot would silently steal the first one's channel.
 */
function duplicateIdentities(runtimes) {
  const seen = new Map();
  const clashes = [];

  for (const runtime of runtimes) {
    if (!runtime.label.startsWith('apps/bot')) continue;
    const token = runtime.source.BOT_TOKEN ?? '';
    if (token === '') continue;

    const first = seen.get(token);
    if (first === undefined) seen.set(token, runtime.label);
    else clashes.push(`${first} and ${runtime.label} share the same BOT_TOKEN`);
  }

  return clashes;
}

/**
 * `--production` validates against production rules regardless of the NODE_ENV
 * in `.env`. Redis and Lavalink are optional locally but mandatory once
 * deployed, so this answers "would this configuration boot in production?"
 * without having to edit `.env` to find out.
 */
const asProduction = process.argv.includes('--production');
const source = asProduction ? { ...env, NODE_ENV: 'production' } : env;

if (asProduction) {
  console.log(`${DIM}Validating against production rules (NODE_ENV=production).${RESET}\n`);
}

let failed = false;

const runtimes = botIdentities(source);

for (const clash of duplicateIdentities(runtimes)) {
  failed = true;
  console.error(`${RED}\u2717${RESET} ${clash}.`);
  console.error(`  ${DIM}Each bot needs its own Discord application.${RESET}\n`);
}

for (const problem of unconfiguredProfiles(source)) {
  failed = true;
  console.error(`${RED}\u2717${RESET} ${problem}.`);
  console.error(`  ${DIM}Create the application, or drop it from COMPOSE_PROFILES.${RESET}\n`);
}

for (const { label, schema, source: identity } of runtimes) {
  try {
    parseEnv(schema, identity, label);
    console.log(`${GREEN}✓${RESET} ${label} configuration is valid`);
  } catch (error) {
    failed = true;
    console.error(`${RED}✗${RESET} ${error.message}\n`);
  }
}

// Surface optional-but-absent infrastructure so a degraded local setup is a
// conscious choice rather than a surprise when a feature silently does nothing.
if (!asProduction && !failed) {
  const disabled = [];
  if (!source.REDIS_URL) disabled.push('Redis — caching and rate limiting disabled');
  if (!source.LAVALINK_HOST || !source.LAVALINK_PASSWORD) {
    disabled.push('Lavalink — music playback disabled');
  }

  if (disabled.length > 0) {
    console.warn(`\n${YELLOW}!${RESET} Optional infrastructure not configured:`);
    for (const item of disabled) console.warn(`  ${DIM}• ${item}${RESET}`);
    console.warn(
      `  ${DIM}Required in production — verify with: pnpm run check:env -- --production${RESET}`,
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\n${GREEN}All environment variables are valid.${RESET}`);
