import { describe, expect, it } from 'vitest';

import { isSoundcloudEnabled } from './env.js';

describe('isSoundcloudEnabled', () => {
  it('is off when SOUNDCLOUD_ENABLED is not set', () => {
    // The vitest environment (vitest.config.ts) does not set the flag, so this
    // is the real schema default, not a mocked one. Off by default because
    // every scsearch: lookup failed in production with "Did not detect any
    // supported formats" and only added latency.
    expect(isSoundcloudEnabled()).toBe(false);
  });
});
