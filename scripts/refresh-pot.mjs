#!/usr/bin/env node
/**
 * Mint a fresh YouTube proof-of-origin token and write it into `.env`.
 *
 *   pnpm run pot:refresh          # mint, write, restart Lavalink
 *   pnpm run pot:refresh --clear  # blank the pair instead
 *
 * Why this exists
 * ---------------
 * YouTube periodically decides a host is a bot and refuses playback on every
 * client at once — "This video requires login", "Sign in to confirm you're not
 * a bot", a bare 403, or (the WEB client's quieter version of the same answer)
 * "No supported audio streams available, available types:" with an empty list.
 * A poToken is upstream's remedy for the WEB and WEBEMBEDDED clients.
 *
 * Two properties make this a recurring chore rather than a one-time setup, and
 * they are the reason this is a script and not a paragraph in the README:
 *
 *   - The token expires. Roughly six hours, and the server tells us exactly
 *     when; `expiresAt` is echoed below so the next run can be scheduled.
 *   - The token is bound to the egress IP that minted it. Generating one
 *     somewhere else, or keeping one across a network change, yields a value
 *     that is silently worthless rather than visibly wrong.
 *
 * The generator the config used to point at
 * (quay.io/invidious/youtube-trusted-session-generator) no longer works — every
 * run ends in "[potoken] failed to extract token" — so this drives Brainicism's
 * bgutil provider instead, which is maintained and does the same job.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const IMAGE = 'brainicism/bgutil-ytdlp-pot-provider';
const CONTAINER = 'dmp-pot-oneshot';
const PORT = 4416;

const clear = process.argv.includes('--clear');

/** Rewrite one `KEY=` line in place, leaving the surrounding comments alone. */
function setEnv(source, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(source)) throw new Error(`${key} is missing from .env`);
  return source.replace(pattern, `${key}=${value}`);
}

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function mint() {
  // `docker rm -f` on a container that does not exist is an error, not a no-op.
  try {
    docker('rm', '-f', CONTAINER);
  } catch {
    /* nothing to remove */
  }

  console.log(`Starting ${IMAGE} …`);
  docker('run', '--name', CONTAINER, '-d', '-p', `${PORT}:${PORT}`, IMAGE);

  try {
    // The provider answers /ping within a second or two of the port opening,
    // but the image may still be warming its Botguard VM on a cold start.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/ping`, { signal: AbortSignal.timeout(3000) });
        break;
      } catch (error) {
        if (attempt >= 30) throw new Error(`provider never became ready: ${String(error)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // An empty body lets the provider mint its own content binding. That is the
    // right call here: the binding and the token have to agree, and letting one
    // side produce both removes the chance of pairing a token with the wrong
    // visitor data. Note the field is `content_binding` — `visitor_data` is
    // accepted only to answer it with a deprecation error.
    const response = await fetch(`http://127.0.0.1:${PORT}/get_pot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(`provider refused: ${body.error ?? response.status}`);
    }

    return {
      // Percent-decoded: YouTube emits visitor data percent-encoded in page
      // source, but the plugin sends this value as a header verbatim.
      visitorData: decodeURIComponent(body.contentBinding),
      poToken: body.poToken,
      expiresAt: body.expiresAt,
    };
  } finally {
    try {
      docker('rm', '-f', CONTAINER);
    } catch {
      /* best effort */
    }
  }
}

let env = readFileSync(ENV_PATH, 'utf8');

if (clear) {
  env = setEnv(env, 'YT_PO_TOKEN', '');
  env = setEnv(env, 'YT_VISITOR_DATA', '');
  writeFileSync(ENV_PATH, env);
  console.log('Cleared YT_PO_TOKEN and YT_VISITOR_DATA.');
} else {
  const { visitorData, poToken, expiresAt } = await mint();
  env = setEnv(env, 'YT_PO_TOKEN', poToken);
  env = setEnv(env, 'YT_VISITOR_DATA', visitorData);
  writeFileSync(ENV_PATH, env);
  console.log(`Wrote a new pair to .env (expires ${expiresAt}).`);
}

// Lavalink reads plugins.youtube.pot once, at startup.
console.log('Restarting Lavalink so the plugin picks it up …');
execFileSync(
  'docker',
  ['compose', '--env-file', '.env', '-f', 'docker/docker-compose.yml', 'up', '-d', 'lavalink'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? 'default' },
  },
);
