-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastDailyBonus" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'USER';

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");
