import 'server-only';

/**
 * Application-layer encryption for third-party tokens (docs/SECURITY.md).
 *
 * AES-256-GCM with a key derived from NEXTAUTH_SECRET — no extra secret to
 * provision, and rotating NEXTAUTH_SECRET deliberately invalidates stored
 * tokens (they refresh on next use or force a relink). Output format is
 * `v1.<iv>.<ciphertext>.<authTag>` base64url, so future schemes can coexist.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { getEnv } from '@/lib/env';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function key(): Buffer {
  return createHash('sha256').update(`${getEnv().NEXTAUTH_SECRET}:token-encryption`).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** Decrypt a stored token; null when malformed or tampered with. */
export function decryptToken(stored: string): string | null {
  const [version, ivPart, dataPart, tagPart] = stored.split('.');
  if (
    version !== VERSION ||
    ivPart === undefined ||
    dataPart === undefined ||
    tagPart === undefined
  ) {
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
