-- Add active-state tracking for guild installations.
ALTER TABLE "guilds"
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false;
