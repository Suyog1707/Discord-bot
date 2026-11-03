import { describe, expect, it } from 'vitest';
import { assessAudioHealth, type LavalinkStatsLike } from './audio-health.js';

function stats(frameStats: LavalinkStatsLike['frameStats']): LavalinkStatsLike {
  return {
    playingPlayers: 2,
    memory: { used: 123 },
    cpu: { systemLoad: 0.4, lavalinkLoad: 0.1 },
    frameStats,
  };
}

describe('assessAudioHealth', () => {
  it('logs a clean minute at debug', () => {
    const r = assessAudioHealth(stats({ sent: 6000, nulled: 0, deficit: 0 }));
    expect(r?.level).toBe('debug');
    expect(r?.fields).toMatchObject({ lossPct: 0, playingPlayers: 2, memoryUsed: 123 });
  });

  it('warns on a deficit and computes lossPct', () => {
    const r = assessAudioHealth(stats({ sent: 2900, nulled: 0, deficit: 100 }));
    expect(r?.level).toBe('warn');
    expect(r?.message).toBe('Lavalink audio frames dropped');
    expect(r?.fields.lossPct).toBe(3.33);
    expect(r?.fields.lavalinkLoad).toBe(0.1);
    expect(r?.fields.systemLoad).toBe(0.4);
  });

  it('warns on nulled frames', () => {
    expect(assessAudioHealth(stats({ sent: 2990, nulled: 10, deficit: 0 }))?.level).toBe('warn');
  });

  it('reports nothing without frame stats', () => {
    expect(assessAudioHealth(stats(null))).toBeNull();
  });

  it('is safe when every counter is zero', () => {
    const r = assessAudioHealth(stats({ sent: 0, nulled: 0, deficit: 0 }));
    expect(r?.fields.lossPct).toBe(0);
    expect(r?.level).toBe('debug');
  });
});
