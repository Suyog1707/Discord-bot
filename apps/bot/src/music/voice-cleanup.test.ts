import { describe, expect, it } from 'vitest';

import { decideVoiceCleanup } from './voice-cleanup.js';

describe('decideVoiceCleanup', () => {
  it('joins straight away when nothing holds voice', () => {
    expect(decideVoiceCleanup({ shoukakuHoldsGuild: false, discordVoiceChannelId: null })).toBe(
      'none',
    );
  });

  /**
   * The regression: a previous process died without a graceful shutdown, or a
   * handshake timed out and left Discord believing the bot was still in the
   * room. Joining that same channel is a no-op to Discord, so the next attempt
   * waits out the full 15 seconds and 24/7 restore gives up on the guild.
   */
  it('clears a voice state Discord kept after the connection went away', () => {
    expect(decideVoiceCleanup({ shoukakuHoldsGuild: false, discordVoiceChannelId: 'vc-1' })).toBe(
      'voice-state',
    );
  });

  it('releases a Shoukaku connection that outlived its player', () => {
    expect(decideVoiceCleanup({ shoukakuHoldsGuild: true, discordVoiceChannelId: null })).toBe(
      'connection',
    );
  });

  /**
   * Shoukaku's teardown is the one that also tells Discord, so resetting the
   * gateway state underneath it would strand the connection it still holds.
   */
  it('prefers releasing the connection when both are stale', () => {
    expect(decideVoiceCleanup({ shoukakuHoldsGuild: true, discordVoiceChannelId: 'vc-1' })).toBe(
      'connection',
    );
  });
});
