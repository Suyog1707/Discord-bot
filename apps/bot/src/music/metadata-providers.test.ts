/**
 * Identifying a free-text query when Spotify could not.
 *
 * Only the ordering is under test here: Deezer's answer wins because it carries
 * an ISRC, but Apple is asked at the same time rather than after Deezer comes
 * back empty. The catalogues are stubbed at `fetch`, which is the one seam both
 * lookups share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMetadataCache, identifyCanonicalTrack } from './metadata-providers.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const DEEZER_HIT = {
  id: 1,
  title: 'Blinding Lights',
  duration: 200,
  artist: { name: 'The Weeknd' },
};
const APPLE_HIT = {
  trackId: 9,
  trackName: 'Blinding Lights',
  artistName: 'The Weeknd',
  trackTimeMillis: 200_000,
};

describe('identifyCanonicalTrack', () => {
  beforeEach(() => {
    clearMetadataCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks Apple while Deezer is still answering, and prefers Deezer', async () => {
    const requested: string[] = [];
    let releaseDeezer = (): void => undefined;
    const deezerGate = new Promise<void>((resolve) => {
      releaseDeezer = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        requested.push(`${url.hostname}${url.pathname}`);
        if (url.hostname === 'api.deezer.com' && url.pathname === '/search') {
          await deezerGate;
          return json({ data: [DEEZER_HIT] });
        }
        if (url.hostname === 'api.deezer.com') return json({ ...DEEZER_HIT, isrc: 'USUM71900028' });
        if (url.hostname === 'itunes.apple.com') return json({ results: [APPLE_HIT] });
        return new Response('{}', { status: 404 });
      }),
    );

    const identifying = identifyCanonicalTrack('Blinding Lights The Weeknd');
    // Apple has been asked before Deezer's search has answered at all.
    await vi.waitFor(() => {
      expect(requested).toContain('itunes.apple.com/search');
    });
    releaseDeezer();

    const track = await identifying;
    expect(track?.provider).toBe('deezer');
    expect(track?.isrc).toBe('USUM71900028');
  });

  it('uses Apple as soon as Deezer comes back empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.deezer.com') return Promise.resolve(json({ data: [] }));
        if (url.hostname === 'itunes.apple.com') {
          return Promise.resolve(json({ results: [APPLE_HIT] }));
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );

    const track = await identifyCanonicalTrack('Blinding Lights The Weeknd');

    expect(track?.provider).toBe('apple-music');
    expect(track?.title).toBe('Blinding Lights');
  });
});
