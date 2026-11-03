/**
 * `/play`'s `source` option.
 *
 * SoundCloud search is off by default, so the command must not offer a choice
 * that can only be refused, and its description must name YouTube as the default.
 */
import type * as EnvModule from '../../config/env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../config/env.js');
});

/** Load a fresh `/play` with the flag set, since the choices are fixed at build time. */
async function loadPlay(enabled: boolean) {
  vi.resetModules();
  vi.doMock('../../config/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof EnvModule>()),
    isSoundcloudEnabled: () => enabled,
  }));
  return (await import('./play.js')).default;
}

function sourceOption(command: Awaited<ReturnType<typeof loadPlay>>) {
  const json = command.data.toJSON();
  const option = json.options?.find((entry) => entry.name === 'source');
  return option as { description: string; choices?: { name: string; value: string }[] } | undefined;
}

describe('/play source option', () => {
  it('excludes SoundCloud when the flag is off', async () => {
    const option = sourceOption(await loadPlay(false));
    expect(option?.choices?.map((choice) => choice.value)).toEqual(['youtube']);
    expect(option?.description).toContain('default: YouTube');
    expect(option?.description).not.toContain('SoundCloud');
  });

  it('includes SoundCloud when the flag is on', async () => {
    const option = sourceOption(await loadPlay(true));
    expect(option?.choices?.map((choice) => choice.value)).toEqual(['youtube', 'soundcloud']);
  });
});
