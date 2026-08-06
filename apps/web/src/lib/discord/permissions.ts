/**
 * Discord permission bitfield helpers.
 *
 * Pure and isomorphic — usable from server code, client components and tests.
 * Bitfields arrive as decimal strings because they exceed 2^53.
 */

/** MANAGE_GUILD (0x20) — the permission that gates dashboard management. */
const MANAGE_GUILD = 1n << 5n;
/** ADMINISTRATOR (0x8) implies every permission. */
const ADMINISTRATOR = 1n << 3n;

/** Whether a member with this bitfield may manage the guild on the dashboard. */
export function canManageGuild(permissions: string, isOwner: boolean): boolean {
  if (isOwner) return true;

  let bits: bigint;
  try {
    bits = BigInt(permissions);
  } catch {
    return false;
  }
  return (bits & ADMINISTRATOR) !== 0n || (bits & MANAGE_GUILD) !== 0n;
}

/** Generic single-permission check against a decimal bitfield string. */
export function hasPermission(permissions: string, bit: bigint): boolean {
  try {
    return (BigInt(permissions) & bit) !== 0n;
  } catch {
    return false;
  }
}

export const PERMISSION_BITS = {
  ADMINISTRATOR,
  MANAGE_GUILD,
} as const;
