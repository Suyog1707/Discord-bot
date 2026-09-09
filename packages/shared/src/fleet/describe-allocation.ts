/**
 * What to tell somebody when no bot can take their channel.
 *
 * Separated from the code that allocates because the two now run in different
 * processes: the command router decides, and the router is also what renders
 * the reply. Keeping the wording here means the "add another bot" link cannot
 * quietly disappear in the move — it is the one moment the multi-bot design
 * becomes visible to a user, and it is the difference between a dead end and a
 * one-click fix.
 *
 * Pure, so every message is a row in a test rather than a fleet state to
 * reproduce.
 */
import { botInviteUrl } from '../discord/index.js';

import type { Allocation } from './bot-allocation.js';
import type { FleetView } from './index.js';

/** An allocation that named no bot — the only kind with anything to say. */
export type RefusedAllocation = Extract<Allocation, { readonly kind: 'invite' | 'full' }>;

/**
 * The reply for an allocation that named no bot.
 *
 * Takes only the refusing kinds, so a caller has to narrow before asking —
 * which is also the narrowing it needs anyway to reach the bot id in the
 * success case.
 */
export function describeAllocation(
  allocation: RefusedAllocation,
  view: FleetView,
  guildId: string,
): string {
  if (allocation.kind === 'invite') {
    const [next] = view.uninvited;
    if (next === undefined) {
      // `invite` said one existed, so the view changed underneath us. Say the
      // true thing rather than offering a link to nobody.
      return 'Every player is busy in another channel right now. Try again shortly.';
    }
    return (
      `Every player is busy in another channel. Add **${next.botId}** to this server and ` +
      `it can play here too:\n${botInviteUrl({
        clientId: next.clientId,
        guildId,
        // A player registers no slash commands.
        withCommands: false,
      })}`
    );
  }

  const busy = view.members
    .filter((member) => member.serving !== null)
    .map((member) => `<#${String(member.serving?.voiceChannelId)}>`)
    .join(', ');

  return busy === ''
    ? 'No player is available right now. Try again shortly.'
    : `Every player is already busy — currently in ${busy}. Wait for one to finish, ` +
        'or join one of those channels.';
}
