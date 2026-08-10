import 'server-only';

/**
 * Guild-level authorization (docs/SECURITY.md: authorization).
 *
 * A dashboard user may manage a guild when Discord says they can (owner,
 * admin, or Manage Server — via the OAuth guild list) *and* the bot is
 * actually in that guild. Both facts are checked here, in one place, and
 * every guild-scoped route/service goes through it.
 */
import { ForbiddenError, NotFoundError } from '@discord-music/shared';
import type { Guild } from '@discord-music/database';

import { fetchManageableGuilds, type DiscordGuildSummary } from '@/lib/discord/api';
import { getDb } from '@/lib/db';

export interface AuthorizedGuild {
  /** Database row (internal ids for joins). */
  readonly guild: Guild;
  /** Discord's view (name, icon, permissions). */
  readonly summary: DiscordGuildSummary;
}

/**
 * Assert the user manages `discordGuildId` and the bot is present.
 *
 * @throws {ForbiddenError} User lacks Manage Server on that guild.
 * @throws {NotFoundError} Bot is not (or no longer) in the guild.
 */
export async function requireManagedGuild(
  userId: string,
  discordGuildId: string,
): Promise<AuthorizedGuild> {
  const manageable = await fetchManageableGuilds(userId);
  const summary = manageable.find((candidate) => candidate.id === discordGuildId);

  if (summary === undefined) {
    // Also thrown for guilds the user is merely a member of: from the caller's
    // perspective a guild they cannot manage does not exist on this dashboard.
    throw new ForbiddenError('You do not manage that server.');
  }

  const guild = await getDb().guild.findUnique({ where: { discordId: discordGuildId } });
  if (guild?.isActive !== true) {
    throw new NotFoundError('The bot is not in that server. Invite it first.');
  }

  return { guild, summary };
}
