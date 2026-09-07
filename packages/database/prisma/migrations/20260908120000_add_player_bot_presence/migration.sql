-- Which player bots exist, and which servers have them.
--
-- Discord allows one voice connection per guild per token, so playing in
-- several channels of one server at once means running as several
-- applications. Two facts follow that `Guild.isActive` cannot hold: which
-- applications this deployment has, and which of them a given server has
-- actually invited.
--
--   * player_bots — the roster, written by each client as it starts. It has to
--     include players that have never joined anything, because offering an
--     invite for one is the whole point.
--   * guild_bots — presence per (server, player). This is what lets the bot
--     say "every player here is busy, add another" and mean something by it.
--
-- `Guild.isActive` deliberately keeps its meaning: whether the PRIMARY is
-- installed. It gates dashboard access, and that question is about the bot
-- people talk to, not about how many spare players a server has added — so
-- every existing read of it stays correct without change.
--
-- No foreign key from guild_bots to player_bots on purpose: a guild event can
-- arrive before the roster row is written, and a presence record that failed
-- on ordering would be worse than one that stands alone.
-- CreateTable
CREATE TABLE "player_bots" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "player_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_bots" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "botClientId" TEXT NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMPTZ(3),
    "leftAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guild_bots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "player_bots_clientId_key" ON "player_bots"("clientId");

-- CreateIndex
CREATE INDEX "guild_bots_guildId_present_idx" ON "guild_bots"("guildId", "present");

-- CreateIndex
CREATE UNIQUE INDEX "guild_bots_guildId_botClientId_key" ON "guild_bots"("guildId", "botClientId");

-- AddForeignKey
ALTER TABLE "guild_bots" ADD CONSTRAINT "guild_bots_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

