/**
 * Who may control playback, and where.
 *
 * The DJ role alone was a poor fit for how people actually use the bot: it
 * needed an admin to create a Discord role and hand it out before anybody
 * could skip a song, and it could not express the ordinary case at all —
 * the person who summoned the bot wanting to share control with whoever is
 * in the channel with them.
 *
 * So authority is session-shaped instead. Whoever starts the music hosts that
 * session, hands DJ to people sitting with them, and everyone else can still
 * queue. The standing configuration (a DJ role, or users named on the
 * dashboard) still counts, but it is **not** a guild-wide grant: like the host
 * and the in-session grants, it only means anything inside the voice channel
 * the bot is actually playing in. A DJ-role holder two channels away has no
 * more say over this room's music than anyone else.
 *
 * The decision itself is pure so the whole table can be tested without a
 * gateway; the registry below is the only mutable part.
 */

export type DjVerdict =
  /** Go ahead. */
  | 'allowed'
  /** Authority is scoped to the bot's channel and they are not in it. */
  | 'not-in-channel'
  /** In the room, but neither host, session DJ, nor standing DJ. */
  | 'not-dj';

export interface DjAuthorityInput {
  readonly memberId: string;
  /** The voice channel the member is sitting in, or null if none. */
  readonly memberVoiceChannelId: string | null;
  /** The channel the bot is playing in, or null when there is no live session. */
  readonly botVoiceChannelId: string | null;
  /** Manage Server: the admin safety valve, deliberately not channel-scoped. */
  readonly hasManageGuild: boolean;
  /** Who summoned this session, or null before anyone's request has played. */
  readonly hostId: string | null;
  /** Granted by the host, for this session only. */
  readonly sessionDjIds: readonly string[];
  readonly memberRoleIds: readonly string[];
  readonly djRoleId: string | null;
  readonly djUserIds: readonly string[];
}

/**
 * Decide whether this member may run a control command right now.
 *
 * Order matters. The admin valve comes first so a runaway bot can always be
 * stopped, even from outside the channel. Everything after it is scoped to the
 * session.
 */
export function decideDjAuthority(input: DjAuthorityInput): DjVerdict {
  if (input.hasManageGuild) return 'allowed';

  const holdsStandingDj =
    (input.djRoleId !== null && input.memberRoleIds.includes(input.djRoleId)) ||
    input.djUserIds.includes(input.memberId);
  const configured = input.djRoleId !== null || input.djUserIds.length > 0;

  // No live session: there is no channel to scope to, so fall back to exactly
  // the rule that applied before session DJs existed.
  if (input.botVoiceChannelId === null) {
    if (!configured) return 'allowed';
    return holdsStandingDj ? 'allowed' : 'not-dj';
  }

  if (input.memberVoiceChannelId !== input.botVoiceChannelId) return 'not-in-channel';

  if (input.hostId !== null && input.memberId === input.hostId) return 'allowed';
  if (input.sessionDjIds.includes(input.memberId)) return 'allowed';
  if (holdsStandingDj) return 'allowed';

  /**
   * A session nobody owns, in a guild that configured nothing. Locking the
   * room out of its own music would be a worse answer than the permissive
   * behaviour they have today — this is the restored-24/7-queue case, where
   * playback is running but no request of anyone's has been seen yet.
   */
  if (input.hostId === null && !configured) return 'allowed';

  return 'not-dj';
}

/** One guild's live session ownership. */
interface SessionState {
  hostId: string | null;
  readonly djIds: Set<string>;
}

/**
 * Session hosts and their DJ grants, for the life of a playback session.
 *
 * Deliberately in memory and deliberately **not** owned by `GuildPlayer`.
 * A voice reconnect destroys and rebuilds the player under the listeners'
 * feet; if grants lived on the player, every reconnect would silently strip
 * everyone's DJ status mid-song. They are cleared when the session genuinely
 * ends instead — see `MusicManager.destroyPlayer`.
 */
export class SessionDjRegistry {
  readonly #guilds = new Map<string, SessionState>();

  #stateOf(guildId: string): SessionState {
    const existing = this.#guilds.get(guildId);
    if (existing !== undefined) return existing;

    const fresh: SessionState = { hostId: null, djIds: new Set() };
    this.#guilds.set(guildId, fresh);
    return fresh;
  }

  host(guildId: string): string | null {
    return this.#guilds.get(guildId)?.hostId ?? null;
  }

  /**
   * Record the session's host.
   *
   * First writer wins: the host is whoever started the music, and a later
   * request from somebody else must not quietly take the room over. Use
   * {@link claimHost} for the deliberate hand-over.
   */
  setHost(guildId: string, memberId: string): void {
    const state = this.#stateOf(guildId);
    state.hostId ??= memberId;
  }

  /** Deliberate hand-over (`/autoplay claim`), which does override. */
  claimHost(guildId: string, memberId: string): void {
    this.#stateOf(guildId).hostId = memberId;
  }

  grant(guildId: string, memberId: string): void {
    this.#stateOf(guildId).djIds.add(memberId);
  }

  /** @returns whether they actually held a grant. */
  revoke(guildId: string, memberId: string): boolean {
    return this.#guilds.get(guildId)?.djIds.delete(memberId) ?? false;
  }

  isSessionDj(guildId: string, memberId: string): boolean {
    return this.#guilds.get(guildId)?.djIds.has(memberId) ?? false;
  }

  /** Granted DJs, host excluded — the host is authority in its own right. */
  djIds(guildId: string): readonly string[] {
    return [...(this.#guilds.get(guildId)?.djIds ?? [])];
  }

  /** End of session: the next person to summon the bot starts fresh. */
  clear(guildId: string): void {
    this.#guilds.delete(guildId);
  }
}
