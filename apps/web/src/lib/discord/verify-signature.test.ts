/**
 * The signature check is the only thing standing between a public URL and a
 * bot that will say anything, so it is tested against a real Ed25519 keypair
 * rather than a mock — the same primitive Discord signs with.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { secretsMatch, verifyDiscordSignature } from './verify-signature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/** Discord publishes the bare 32 bytes; the DER export carries a 12-byte header. */
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

const TIMESTAMP = '1700000000';
const BODY = JSON.stringify({ type: 2, data: { name: 'play' } });

function signed(timestamp: string, body: string): string {
  return sign(null, Buffer.from(timestamp + body, 'utf8'), privateKey).toString('hex');
}

const valid = {
  rawBody: BODY,
  signature: signed(TIMESTAMP, BODY),
  timestamp: TIMESTAMP,
  publicKey: publicKeyHex,
};

describe('verifyDiscordSignature', () => {
  it('accepts a genuine request', () => {
    expect(verifyDiscordSignature(valid)).toBe(true);
  });

  it('rejects a body that was altered in flight', () => {
    const tampered = JSON.stringify({ type: 2, data: { name: 'stop' } });

    expect(verifyDiscordSignature({ ...valid, rawBody: tampered })).toBe(false);
  });

  it('rejects a replay under a different timestamp', () => {
    // The timestamp is part of the signed message precisely so a captured
    // request cannot be replayed later.
    expect(verifyDiscordSignature({ ...valid, timestamp: '1700009999' })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const forged = sign(null, Buffer.from(TIMESTAMP + BODY, 'utf8'), other.privateKey);

    expect(verifyDiscordSignature({ ...valid, signature: forged.toString('hex') })).toBe(false);
  });

  it('rejects a missing signature or timestamp', () => {
    expect(verifyDiscordSignature({ ...valid, signature: null })).toBe(false);
    expect(verifyDiscordSignature({ ...valid, timestamp: null })).toBe(false);
  });

  it('rejects rubbish in the signature header without throwing', () => {
    // Discord probes the endpoint with deliberately-bad signatures when the URL
    // is saved, so this path is exercised for real before anything else is.
    expect(verifyDiscordSignature({ ...valid, signature: 'not-hex' })).toBe(false);
    expect(verifyDiscordSignature({ ...valid, signature: '' })).toBe(false);
    expect(verifyDiscordSignature({ ...valid, signature: 'ab'.repeat(64) })).toBe(false);
  });

  it('rejects everything when the configured key is malformed', () => {
    // `Buffer.from` truncates bad hex rather than throwing, so a typo in the
    // environment would otherwise produce a short key and a confusing error.
    expect(verifyDiscordSignature({ ...valid, publicKey: 'nonsense' })).toBe(false);
    expect(verifyDiscordSignature({ ...valid, publicKey: '' })).toBe(false);
  });

  it('accepts an empty body that was signed as empty', () => {
    expect(
      verifyDiscordSignature({
        ...valid,
        rawBody: '',
        signature: signed(TIMESTAMP, ''),
      }),
    ).toBe(true);
  });
});

describe('secretsMatch', () => {
  it('matches identical secrets and rejects everything else', () => {
    expect(secretsMatch('token', 'token')).toBe(true);
    expect(secretsMatch('token', 'token ')).toBe(false);
    expect(secretsMatch('token', 'other')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});
