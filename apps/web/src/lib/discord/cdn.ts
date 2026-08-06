/**
 * Discord CDN URL builders. Pure and isomorphic.
 *
 * Animated assets have hashes prefixed `a_` and are served as GIFs.
 */

const CDN = 'https://cdn.discordapp.com';

export function discordAvatarUrl(user: { id: string; avatar: string | null }): string {
  if (user.avatar === null) {
    // Discord derives the default avatar index from the user id.
    let index = 0;
    try {
      index = Number(BigInt(user.id) >> 22n) % 6;
    } catch {
      // Malformed id: fall back to index 0 rather than a broken URL.
    }
    return `${CDN}/embed/avatars/${String(index)}.png`;
  }
  const format = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `${CDN}/avatars/${user.id}/${user.avatar}.${format}`;
}

export function guildIconUrl(guild: { id: string; icon: string | null }): string | null {
  if (guild.icon === null) return null;
  const format = guild.icon.startsWith('a_') ? 'gif' : 'png';
  return `${CDN}/icons/${guild.id}/${guild.icon}.${format}?size=128`;
}
