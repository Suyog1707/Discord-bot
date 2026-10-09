import { describe, expect, it } from 'vitest';
import { authDiagnostics } from './diagnostics';
describe('safe Auth.js diagnostics', () => {
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
