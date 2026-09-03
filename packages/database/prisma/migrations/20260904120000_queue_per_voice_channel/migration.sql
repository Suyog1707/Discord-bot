-- One queue per voice channel, instead of one per guild.
--
-- Discord keeps a single voice state per (guild, user), so the bot can only
-- ever occupy one voice channel per server at a time. That is a constraint on
-- PLAYBACK, and it was being applied to STORAGE as well: `queues.guildId` was
-- unique, so a guild had exactly one saved queue and moving the bot between
-- channels silently overwrote whatever the previous channel was listening to.
--
-- Now each channel keeps its own list, and returning to a channel resumes it.
--
-- `voiceChannelId` becomes NOT NULL because it is half of the identity: a row
-- without one belongs to no room and could never be restored (`loadPersisted`
-- already treated such rows as absent). The only rows that had NULL were the
-- placeholders `ensureGuild` created on join, which the bot no longer writes.

-- Placeholder rows: unrestorable by construction, and now unrepresentable.
-- Their tracks go with them (ON DELETE CASCADE on queue_tracks.queueId).
DELETE FROM "queues" WHERE "voiceChannelId" IS NULL;

-- A guild may now have several queues, one per channel.
DROP INDEX IF EXISTS "queues_guildId_key";

ALTER TABLE "queues" ALTER COLUMN "voiceChannelId" SET NOT NULL;

CREATE UNIQUE INDEX "queues_guildId_voiceChannelId_key" ON "queues"("guildId", "voiceChannelId");

-- The 24/7 restore asks for a guild's most recently used channel.
CREATE INDEX "queues_guildId_updatedAt_idx" ON "queues"("guildId", "updatedAt");
