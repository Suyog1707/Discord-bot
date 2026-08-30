-- Songs a listener has explicitly rejected, so the recommender stops offering
-- them.
--
-- Keyed by `trackKey` — the canonical `identityOf(author, title).key` — rather
-- than by a provider identifier, because a dislike is about the recording, not
-- about the row that happened to be playing. The same song reaches a guild as a
-- Spotify id one night and a SoundCloud id the next; keying on either would let
-- it come straight back through the other door.
--
-- `isrc` is stored alongside, nullable, purely as a stronger identifier when a
-- provider supplied one. It is indexed but never the unique key: most rows will
-- not have one, and two rows without an ISRC must still be distinguishable.
--
-- `source` records how the dislike was expressed ("button" | "command" |
-- "dashboard"). A free-form String rather than an enum: it is descriptive
-- telemetry, and adding a surface should not need a migration.
--
-- Unique on (userId, trackKey) so disliking the same song twice is idempotent
-- at the database rather than only in the service, and cascading on the user so
-- an account deletion takes its rejections with it.
-- CreateTable
CREATE TABLE "disliked_tracks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackKey" TEXT NOT NULL,
    "isrc" TEXT,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'command',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disliked_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "disliked_tracks_userId_idx" ON "disliked_tracks"("userId");

-- CreateIndex
CREATE INDEX "disliked_tracks_isrc_idx" ON "disliked_tracks"("isrc");

-- CreateIndex
CREATE UNIQUE INDEX "disliked_tracks_userId_trackKey_key" ON "disliked_tracks"("userId", "trackKey");

-- AddForeignKey
ALTER TABLE "disliked_tracks" ADD CONSTRAINT "disliked_tracks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
