-- CreateTable
CREATE TABLE "taste_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "guildId" TEXT,
    "artistAffinity" JSONB NOT NULL DEFAULT '{}',
    "tagAffinity" JSONB NOT NULL DEFAULT '{}',
    "languageAffinity" JSONB NOT NULL DEFAULT '{}',
    "completionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "taste_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "taste_profile_userId_key" ON "taste_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "taste_profile_guildId_key" ON "taste_profile"("guildId");

-- CreateIndex
CREATE INDEX "taste_profile_computedAt_idx" ON "taste_profile"("computedAt");

-- AddForeignKey
ALTER TABLE "taste_profile" ADD CONSTRAINT "taste_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taste_profile" ADD CONSTRAINT "taste_profile_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

