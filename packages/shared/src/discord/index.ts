/**
 * Discord OAuth invite links.
 *
 * Shared because both ends build them and they must agree: the bot offers an
 * invite in a voice channel when every player is busy, and the dashboard shows
 * the same link on the server page. Two copies of a permission integer is two
 * chances for a player to join with the wrong permissions and fail in a way
 * that looks like a bug in playback.
 */

/**
 * Permissions a player needs.
 *
 * Connect, Speak, Send Messages, Embed Links, Read Message History, View
 * Channels. A worker uses only the voice half, but asking for one set keeps
 * the invites identical and lets any player be promoted to primary later
 * without a re-invite.
 */
export const BOT_INVITE_PERMISSIONS = '277083450688';

export interface InviteUrlOptions {
  /** Discord application id of the bot to add. */
  readonly clientId: string;
  /** Pre-select a server. The user can still pick another. */
  readonly guildId?: string;
  /**
   * Whether this bot registers slash commands.
   *
   * Only the primary does, and asking for `applications.commands` on a player
   * that has none puts a permission in the consent screen it will never use.
   */
  readonly withCommands?: boolean;
}

export function botInviteUrl(options: InviteUrlOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    scope: options.withCommands === false ? 'bot' : 'bot applications.commands',
    permissions: BOT_INVITE_PERMISSIONS,
  });
  if (options.guildId !== undefined) params.set('guild_id', options.guildId);
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
