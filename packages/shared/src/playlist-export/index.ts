/**
 * Portable playlist document — the `discord-music-playlist/v1` format shared
 * by the dashboard (JSON download/upload) and the bot (`/playlist export` and
 * `/playlist import` attachments). Version-tagged so future formats can
 * evolve without breaking old files.
 */
import { z } from 'zod';

import { LIMITS } from '../constants/index.js';
import { nonEmptyString } from '../validation/index.js';

export const PLAYLIST_EXPORT_FORMAT = 'discord-music-playlist/v1';

export const playlistExportTrackSchema = z.object({
  // Lavalink's encoded blob is version-specific; imports may omit it and the
  // bot re-resolves by URI at play time, exactly like favorites.
  encoded: z.string().max(4096).optional(),
  identifier: nonEmptyString(200, 'Identifier'),
  title: nonEmptyString(300, 'Title'),
  author: nonEmptyString(200, 'Author'),
  durationMs: z.number().int().min(0),
  uri: z.url().max(1000).nullable().optional(),
  artworkUrl: z.url().max(1000).nullable().optional(),
  source: z.enum(['youtube', 'spotify', 'soundcloud', 'deezer']),
});

export const playlistExportSchema = z.object({
  format: z.literal(PLAYLIST_EXPORT_FORMAT),
  name: nonEmptyString(LIMITS.PLAYLIST_NAME_MAX_LENGTH, 'Playlist name'),
  description: z.string().trim().max(LIMITS.PLAYLIST_DESCRIPTION_MAX_LENGTH).nullable(),
  folder: z.string().trim().min(1).max(LIMITS.PLAYLIST_NAME_MAX_LENGTH).nullable(),
  tracks: z.array(playlistExportTrackSchema).max(LIMITS.PLAYLIST_MAX_TRACKS),
});

export type PlaylistExport = z.infer<typeof playlistExportSchema>;
export type PlaylistExportTrack = z.infer<typeof playlistExportTrackSchema>;
