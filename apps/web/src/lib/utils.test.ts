import { describe, expect, it } from 'vitest';

import { cn, formatCompactNumber, formatDuration, truncate } from './utils';

describe('cn', () => {
  it('merges conditional class names', () => {
    const isActive = Math.random() < 0; // Always false, but opaque to the compiler.
    expect(cn('a', isActive && 'b', 'c')).toBe('a c');
  });

  it('lets a later Tailwind utility win over an earlier one in the same group', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-muted-foreground text-sm', 'text-lg')).toBe('text-muted-foreground text-lg');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5_000, '0:05'],
    [65_000, '1:05'],
    [600_000, '10:00'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
  ])('formats %ims as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('returns 0:00 for negative or non-finite input', () => {
    expect(formatDuration(-1)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatCompactNumber', () => {
  it.each([
    [999, '999'],
    [1_200, '1.2K'],
    [3_400_000, '3.4M'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatCompactNumber(input)).toBe(expected);
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends an ellipsis', () => {
    expect(truncate('a very long track title', 10)).toBe('a very lo…');
  });
});
