import { describe, expect, it } from 'vitest';
import { authDiagnostics } from './diagnostics';
describe('safe Auth.js diagnostics', () => {
  it('identifies a non-object token response without exposing its body', () => {
    const error = Object.assign(new Error('"response" body must be a top level object'), {
      code: 'OAUTH_INVALID_RESPONSE',
      cause: { body: ['private-token'] },
    });
    expect(authDiagnostics(error)).toMatchObject({
      causes: [{ category: 'OAuth response JSON is not an object' }, {}],
    });
    expect(JSON.stringify(authDiagnostics(error))).not.toContain('private-token');
  });
  it('identifies malformed token fields without logging their values or response bodies', () => {
    const error = Object.assign(
      new Error('"response" body "access_token" property must be a non-empty string'),
      {
        code: 'OAUTH_INVALID_RESPONSE',
        cause: { body: { refresh_token: 'private' } },
      },
    );
    expect(authDiagnostics(error)).toMatchObject({
      causes: [
        { property: 'access_token', category: 'OAuth response property missing or invalid' },
        {},
      ],
    });
    expect(JSON.stringify(authDiagnostics(error))).not.toContain('private');
  });
  it('identifies a missing callback code', () => {
    expect(
      authDiagnostics(new Error('no authorization code in "callbackParameters"')),
    ).toMatchObject({ causes: [{ category: 'OAuth callback missing authorization code' }] });
  });
  it('preserves a nested Prisma failure hidden in cause.err', () => {
    const inner = Object.assign(new Error('Unique constraint password=private'), { code: 'P2002' });
    const outer = new Error('callback', { cause: { err: inner } });
    expect(authDiagnostics(outer)).toMatchObject({
      causes: [
        { name: 'Error' },
        { code: 'P2002', category: 'Database identity uniqueness conflict' },
      ],
    });
    expect(JSON.stringify(authDiagnostics(outer))).not.toContain('private');
  });
  it('does not emit credentials or URLs from OAuth failures', () => {
    const result = authDiagnostics(
      new Error('invalid_client https://discord.com?code=private secret=private'),
    );
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result).toMatchObject({ causes: [{ category: 'Discord client credentials rejected' }] });
  });
  it('bounds recursive causes', () => {
    const error = new Error('private');
    error.cause = error;
    expect(authDiagnostics(error).causes as unknown[]).toHaveLength(5);
  });
});
