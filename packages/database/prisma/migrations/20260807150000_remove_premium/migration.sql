-- AlterEnum
BEGIN;
CREATE TYPE "verification_type_new" AS ENUM ('ACCOUNT_LINK', 'GUILD_CLAIM');
ALTER TABLE "verifications" ALTER COLUMN "type" TYPE "verification_type_new" USING ("type"::text::"verification_type_new");
ALTER TYPE "verification_type" RENAME TO "verification_type_old";
ALTER TYPE "verification_type_new" RENAME TO "verification_type";
DROP TYPE "public"."verification_type_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "premium" DROP CONSTRAINT "premium_guildId_fkey";

-- DropForeignKey
ALTER TABLE "premium" DROP CONSTRAINT "premium_userId_fkey";

-- DropTable
DROP TABLE "premium";

-- DropEnum
DROP TYPE "premium_tier";

