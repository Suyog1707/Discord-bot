import { describe, expect, it } from 'vitest';
import { spotifyRequestError } from './errors.js';
import { ConfigurationError, ValidationError, userErrorMessage } from '../errors/index.js';

describe('safe user-facing errors', () => {
  it.each([
    [401, 'Reconnect Spotify'],
    [403, 'own or collaborate'],
    [404, 'private, or deleted'],
    [429, 'Retry in 30 seconds'],
    [503, 'Try again shortly'],
  ])('explains Spotify status %s', (status, message) => {
    expect(spotifyRequestError(status).message).toContain(message);
  });
  it('honors bounded rate-limit hints', () => {
    expect(spotifyRequestError(429, '120').message).toContain('120 seconds');
    expect(spotifyRequestError(429, '-1').message).toContain('30 seconds');
  });
  it('does not expose unexpected or configuration secrets', () => {
    for (const error of [new Error('password=secret'), new ConfigurationError('token=secret')]) {
      expect(userErrorMessage(error)).not.toContain('secret');
    }
  });
  it('preserves expected validation guidance', () => {
    expect(userErrorMessage(new ValidationError('Join a voice channel.'))).toBe(
      'Join a voice channel.',
    );
  });
  it('classifies database failures and wrapped timeouts', () => {
    expect(userErrorMessage(Object.assign(new Error('private host'), { code: 'P1001' }))).toContain(
      'database is unavailable',
    );
    expect(
      userErrorMessage(
        new Error('wrapped', {
          cause: Object.assign(new Error('secret'), { name: 'TimeoutError' }),
        }),
      ),
    ).toContain('timed out');
  });
});
