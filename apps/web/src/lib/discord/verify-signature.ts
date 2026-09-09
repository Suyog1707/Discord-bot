import 'server-only';

/**
 * Proving a request really came from Discord.
 *
 * The interactions endpoint is a public URL with no session and no secret in
 * the request — the only thing separating a genuine command from a forgery is
 * an Ed25519 signature over the body. Get this wrong and anybody who finds the
 * URL can make the bot say anything, in any server it is in.
 *
 * No dependency is needed. Node verifies Ed25519 natively; the only wrinkle is
 * that Discord publishes a bare 32-byte key while Node wants SPKI DER, and the
 * difference between the two is a fixed twelve-byte prefix.
 */
import { createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

import { getLogger } from '@/lib/logger';

/** ASN.1 SPKI header for an Ed25519 public key — everything before the bytes. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * Parsing the key is pure CPU but not free, and the key never changes.
 *
 * Keyed by the hex string so a redeploy with a different application — which
 * is exactly what happens while a throwaway app is being used to test — cannot
 * be served by a stale key.
 */
const keyCache = new Map<string, KeyObject>();

function publicKeyFrom(hex: string): KeyObject | null {
  const cached = keyCache.get(hex);
  if (cached !== undefined) return cached;

  try {
    const raw = Buffer.from(hex, 'hex');
    // `Buffer.from` on a bad hex string truncates rather than throwing, so the
    // length check is what actually rejects a malformed key.
    if (raw.length !== ED25519_KEY_BYTES) return null;

    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    keyCache.set(hex, key);
    return key;
  } catch (error) {
    // Resolved at the call site, never at module scope: reading configuration
    // while `next build` collects page data would make the build need secrets.
    getLogger('interactions').error({ err: error }, 'Interactions public key could not be parsed');
    return null;
  }
}

export interface SignatureInput {
  /** The body exactly as received — see the note in the route about why. */
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  /** The command application's public key, as hex. */
  readonly publicKey: string;
}

/**
 * Whether this request carries Discord's signature over this exact body.
 *
 * Never throws: a malformed header is a forgery like any other, and the caller
 * has exactly one thing to do about it either way.
 */
export function verifyDiscordSignature(input: SignatureInput): boolean {
  const { rawBody, signature, timestamp, publicKey } = input;
  if (signature === null || timestamp === null) return false;

  const key = publicKeyFrom(publicKey);
  if (key === null) return false;

  try {
    const signatureBytes = Buffer.from(signature, 'hex');
    if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) return false;

    // The signed message is the timestamp and the body concatenated, in that
    // order, as bytes. Including the timestamp is what stops a captured
    // request being replayed against a later one.
    return verify(null, Buffer.from(timestamp + rawBody, 'utf8'), key, signatureBytes);
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison, for anything else that has to match a secret.
 *
 * Exported so nothing here reaches for `===` on a credential later.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
