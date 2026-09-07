-- Which room a play happened in.
--
-- A server can now play in several voice channels at once, and autoplay reads
-- recent history to decide what not to repeat and what to seed from. Guild-wide
-- history makes those two rooms one crowd: the rock channel's anti-repeat is
-- spent on songs the lo-fi channel played, and both get seeded from each
-- other's music. Recording the channel is what lets a room have a past of its
-- own.
--
--   * song_history.voiceChannelId — nullable on purpose. Rows written before
--     multi-room playback have no room, and a channel that has only just
--     started playing has almost no history of its own; both are read as the
--     server's shared past, so a new room begins with the taste the server
--     already has rather than with none.
--
-- The index mirrors the existing [guildId, playedAt] one with the room in
-- between, which is the shape of the per-room read.
-- AlterTable
ALTER TABLE "song_history" ADD COLUMN "voiceChannelId" TEXT;

-- CreateIndex
CREATE INDEX "song_history_guildId_voiceChannelId_playedAt_idx" ON "song_history"("guildId", "voiceChannelId", "playedAt");
