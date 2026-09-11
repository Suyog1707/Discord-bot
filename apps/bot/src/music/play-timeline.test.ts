import { SnowflakeUtil } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { playTimeline } from './play-timeline.js';

const PRESSED_AT = 1_757_000_000_000;
const INTERACTION_ID = SnowflakeUtil.generate({ timestamp: PRESSED_AT }).toString();

describe('playTimeline', () => {
  it('measures every mark from the moment the command was typed', () => {
    // The snowflake is the only clock that starts before the router does, so
    // it is the only baseline that can see the router's own cost.
    expect(
      playTimeline({
        interactionId: INTERACTION_ID,
        routedAt: PRESSED_AT + 300,
        pickedUpAt: PRESSED_AT + 310,
        executeAt: PRESSED_AT + 330,
        joinStartedAt: PRESSED_AT + 400,
        joinedAt: PRESSED_AT + 900,
        resolvedAt: PRESSED_AT + 1_200,
        playRequestedAt: PRESSED_AT + 1_250,
        audioAt: PRESSED_AT + 1_700,
      }),
    ).toEqual({
      routedMs: 300,
      pickedUpMs: 310,
      executeMs: 330,
      joinStartedMs: 400,
      joinedMs: 900,
      resolvedMs: 1_200,
      playRequestedMs: 1_250,
      audioMs: 1_700,
    });
  });

  it('leaves out what did not happen instead of calling it instant', () => {
    // A gateway command with the bot already in the channel, queued behind a
    // song: no router, no join, no start. Zeros would read as "free".
    expect(
      playTimeline({
        interactionId: INTERACTION_ID,
        executeAt: PRESSED_AT + 50,
        resolvedAt: PRESSED_AT + 800,
        playRequestedAt: PRESSED_AT + 820,
      }),
    ).toEqual({ executeMs: 50, resolvedMs: 800, playRequestedMs: 820 });
  });
});
