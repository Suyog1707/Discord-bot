-- AlterTable
ALTER TABLE "playlists" ADD COLUMN     "folder" TEXT;

-- CreateIndex
CREATE INDEX "playlists_ownerId_folder_idx" ON "playlists"("ownerId", "folder");

