-- AlterTable
ALTER TABLE "guild_settings" ADD COLUMN     "autoplayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stayConnected" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "favorite_tracks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "uri" TEXT,
    "source" "music_source" NOT NULL,
    "artworkUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_tracks_userId_createdAt_idx" ON "favorite_tracks"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_tracks_userId_identifier_key" ON "favorite_tracks"("userId", "identifier");

-- AddForeignKey
ALTER TABLE "favorite_tracks" ADD CONSTRAINT "favorite_tracks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

