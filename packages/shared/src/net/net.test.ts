import { describe, expect, it } from 'vitest';

import { isUnreachableError, summarizeSocketError } from './index.js';

/** Build the shape Node produces for a refused connection to a dual-stack host. */
function connectionRefused(): AggregateError {
  const ipv6 = Object.assign(new Error('connect ECONNREFUSED ::1:2333'), {
    code: 'ECONNREFUSED',
    address: '::1',
    port: 2333,
  });
  const ipv4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2333'), {
    code: 'ECONNREFUSED',
    address: '127.0.0.1',
    port: 2333,
  });
  // Node's AggregateError for this case carries an empty message.
  return Object.assign(new AggregateError([ipv6, ipv4], ''), { code: 'ECONNREFUSED' });
}

describe('summarizeSocketError', () => {
  it('lifts address, port and reason off the first attempt of an AggregateError', () => {
    expect(summarizeSocketError(connectionRefused())).toEqual({
      code: 'ECONNREFUSED',
      address: '::1',
      port: 2333,
      reason: 'connect ECONNREFUSED ::1:2333',
    });
  });

  it('reads a plain socket error directly', () => {
    const error = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      address: '127.0.0.1',
      port: 6379,
    });

    expect(summarizeSocketError(error)).toEqual({
      code: 'ECONNRESET',
      address: '127.0.0.1',
      port: 6379,
      reason: 'read ECONNRESET',
    });
  });

  it('falls back to the error name when there is no code', () => {
    expect(summarizeSocketError(new Error('boom'))).toEqual({
      code: 'Error',
      address: undefined,
      port: undefined,
      reason: 'boom',
    });
  });
});

describe('isUnreachableError', () => {
  it('recognises an aggregate connection refusal', () => {
    expect(isUnreachableError(connectionRefused())).toBe(true);
  });

  it('recognises a code carried only on a sub-error', () => {
    const aggregate = new AggregateError(
      [Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })],
      '',
    );

    expect(isUnreachableError(aggregate)).toBe(true);
  });

  it('recognises the codeless ws handshake failure', () => {
    expect(
      isUnreachableError(new Error('Websocket closed before a connection was established')),
    ).toBe(true);
  });

  it('does not classify an application error as unreachable', () => {
    expect(isUnreachableError(new Error('Invalid session id'))).toBe(false);
    expect(isUnreachableError(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
  });
});
