/**
 * Naming the bot a component belongs to, inside the component's own id.
 *
 * Most buttons can be routed by the message they sit on: the controller is
 * posted by the bot that owns the room, so `message.author.id` names it. That
 * does not work for anything a *command* posted, because every command reply
 * now goes out under the command application's identity whichever bot actually
 * ran it — so the message looks like it came from the same place every time.
 *
 * `/spotify playlists` is the case that needs this. It holds its paging state
 * in a closure behind a component collector, which lives in one process and
 * cannot be looked up from anywhere else. The clicks have to go back to the
 * bot that opened it, so that bot writes its name into the ids it builds.
 *
 * `#` as the separator because the ids already use `:` for their own
 * structure, and Discord's hundred-character limit leaves plenty of room.
 */

const SEPARATOR = '#';

/** Tag a custom id with the bot that must handle it. */
export function withComponentOwner(customId: string, botId: string): string {
  return `${customId}${SEPARATOR}${botId}`;
}

/** The bot named in a custom id, or null when it names none. */
export function componentOwnerOf(customId: string): string | null {
  const index = customId.lastIndexOf(SEPARATOR);
  if (index === -1) return null;
  const botId = customId.slice(index + SEPARATOR.length);
  return botId.length === 0 ? null : botId;
}

/** The id without its owner tag, which is what handlers match on. */
export function baseCustomId(customId: string): string {
  const index = customId.lastIndexOf(SEPARATOR);
  return index === -1 ? customId : customId.slice(0, index);
}
