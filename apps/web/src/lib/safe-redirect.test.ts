import { describe, expect, it } from 'vitest';

import { safeCallbackUrl } from './safe-redirect';

describe('safeCallbackUrl', () => {
  it('accepts clean same-origin paths', () => {
    expect(safeCallbackUrl('/dashboard')).toBe('/dashboard');
    expect(safeCallbackUrl('/dashboard/servers/123?tab=queue')).toBe(
      '/dashboard/servers/123?tab=queue',
    );
  });

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['/\\evil.com', 'backslash slash-state bypass'],
    ['/\\/evil.com', 'mixed slash bypass'],
    ['https://evil.com', 'absolute URL'],
    ['javascript:alert(1)', 'scheme'],
    ['/dash\u0000board', 'NUL control char'],
    ['/dash\tboard', 'tab control char'],
    ['/evil\u007f.com', 'DEL control char'],
    ['', 'empty'],
  ])('rejects %j (%s) and falls back', (input) => {
    expect(safeCallbackUrl(input)).toBe('/dashboard');
  });

  it('handles undefined with a custom fallback', () => {
    expect(safeCallbackUrl(undefined)).toBe('/dashboard');
    expect(safeCallbackUrl(undefined, '/x')).toBe('/x');
  });
});
