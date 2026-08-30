/**
 * `@discord-music/database`
 *
 * The single place the rest of the monorepo touches Postgres. Apps import the
 * client and the generated model types from here — never `@prisma/client`
 * directly — so the ORM stays swappable and generation stays a build step of
 * this package alone.
 */
export {
  createPrismaClient,
  disconnectPrisma,
  getPrismaClient,
  isForeignKeyError,
  isRecordNotFoundError,
  isUniqueConstraintError,
  pingDatabase,
  type CreatePrismaClientOptions,
} from './client.js';

export {
  addDislike,
  countDislikes,
  DISLIKES_MAX_PER_USER,
  DISLIKES_PAGE_LIMIT_DEFAULT,
  DISLIKES_PAGE_LIMIT_MAX,
  dislikedArtistCountsFor,
  dislikedKeysFor,
  dislikesFor,
  isDisliked,
  listDislikes,
  pageDislikes,
  removeDislike,
  removeDislikes,
  type DislikeInput,
  type DislikePage,
  type DislikeSource,
} from './dislikes.js';

export { Prisma, PrismaClient } from '@prisma/client';

export type {
  Account,
  DislikedTrack,
  FavoriteTrack,
  Guild,
  GuildMember,
  GuildSettings,
  Playlist,
  PlaylistTrack,
  Queue,
  QueueTrack,
  Session,
  SongHistory,
  SpotifyAccount,
  User,
  Verification,
  VerificationToken,
} from '@prisma/client';

export { LoopMode, MusicSource, PlaylistVisibility, VerificationType } from '@prisma/client';
