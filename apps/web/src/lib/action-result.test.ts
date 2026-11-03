import { describe, expect, it } from 'vitest';
import { InternalError, UpstreamError } from '@discord-music/shared';

import { errorResult, importSuccessResult, syncSuccessResult } from './action-result';

describe('action results', () => {
  it('words import and sync successes', () => {
    expect(importSuccessResult({ trackCount: 12, changed: true })).toEqual({
      status: 'success',
      message: 'Imported 12 tracks',
    });
    expect(importSuccessResult({ trackCount: 1, changed: true }).status).toBe('success');
    expect(syncSuccessResult({ trackCount: 7, changed: true })).toEqual({
      status: 'success',
      message: 'Synced: 7 tracks',
    });
  });

  it('says "Already up to date" when nothing changed', () => {
    expect(importSuccessResult({ trackCount: 3, changed: false })).toMatchObject({
      message: 'Already up to date',
    });
    expect(syncSuccessResult({ trackCount: 3, changed: false })).toMatchObject({
      message: 'Already up to date',
    });
  });

  it('passes through an expected AppError message (the Spotify 403 case)', () => {
    const message = 'Spotify denied access to this playlist or library.';
    expect(errorResult(new UpstreamError(message))).toEqual({ status: 'error', message });
  });

  it('hides internal details of unexpected errors', () => {
    const result = errorResult(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(errorResult(new InternalError('secret stack')))).not.toContain('secret');
  });
});
