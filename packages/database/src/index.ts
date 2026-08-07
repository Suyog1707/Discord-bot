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

export { Prisma, PrismaClient } from '@prisma/client';

export type {
  Account,
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
  User,
  Verification,
  VerificationToken,
} from '@prisma/client';

export { LoopMode, MusicSource, PlaylistVisibility, VerificationType } from '@prisma/client';
