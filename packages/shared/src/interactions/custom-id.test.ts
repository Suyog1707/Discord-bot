import { describe, expect, it } from 'vitest';

import { baseCustomId, componentOwnerOf, withComponentOwner } from './custom-id.js';

describe('component owner tags', () => {
  it('round trips', () => {
    const tagged = withComponentOwner('spl:next', 'player-2');

    expect(tagged).toBe('spl:next#player-2');
    expect(componentOwnerOf(tagged)).toBe('player-2');
    expect(baseCustomId(tagged)).toBe('spl:next');
  });

  it('leaves an untagged id alone', () => {
    // The controller's buttons are routed by the message they sit on, so they
    // carry no tag and must not appear to.
    expect(componentOwnerOf('music:skip')).toBeNull();
    expect(baseCustomId('music:skip')).toBe('music:skip');
  });

  it('does not mistake the id’s own structure for a tag', () => {
    expect(componentOwnerOf('spl:select')).toBeNull();
    expect(baseCustomId('spl:select')).toBe('spl:select');
  });

  it('reads the last tag when a base already contains the separator', () => {
    expect(componentOwnerOf('odd#name#main')).toBe('main');
    expect(baseCustomId('odd#name#main')).toBe('odd#name');
  });

  it('treats an empty tag as no tag', () => {
    expect(componentOwnerOf('spl:next#')).toBeNull();
  });

  it('stays inside Discord’s hundred-character limit for real ids', () => {
    expect(withComponentOwner('spl:select', 'player-7').length).toBeLessThanOrEqual(100);
  });
});
