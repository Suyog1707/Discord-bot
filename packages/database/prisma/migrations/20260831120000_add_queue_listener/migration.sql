-- Listener identity for persisted queues.
--
-- A restored 24/7 queue used to come back as a list of tracks and nothing
-- else: every track stamped as requested by nobody, and no record of whose
-- taste the session was following. Autoplay then had only the guild's
-- aggregate to work from until somebody typed a new request.
--
--   * queues.listenerId — the primary listener, whose history, library,
--     playlists and dislikes drive autoplay. SET NULL on user deletion: the
--     queue outlives the person, the personalisation does not.
--   * queue_tracks.origin / autoplayKind — who put each track on and, for
--     autoplay's own picks, which half of the familiar/discovery cadence they
--     filled. Without these a restored queue cannot tell anchors from
--     recommendations, and the cadence restarts from zero.
--
-- queue_tracks.requestedById already existed but was never written; the bot
-- now fills it. Existing rows keep NULL / 'user', which is what the restore
-- path already assumed for them.
-- AlterTable
ALTER TABLE "queues" ADD COLUMN "listenerId" TEXT;

-- AlterTable
ALTER TABLE "queue_tracks" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "autoplayKind" TEXT,
ADD COLUMN "sourceKey" TEXT;

-- CreateIndex
CREATE INDEX "queues_listenerId_idx" ON "queues"("listenerId");

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_listenerId_fkey" FOREIGN KEY ("listenerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
