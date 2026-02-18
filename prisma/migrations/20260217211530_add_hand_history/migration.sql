-- CreateTable
CREATE TABLE "HandHistory" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "dealerSeat" INTEGER NOT NULL,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "players" JSONB NOT NULL,
    "board" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "actions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HandHistory_tableId_createdAt_idx" ON "HandHistory"("tableId", "createdAt");

-- CreateIndex
CREATE INDEX "HandHistory_handId_idx" ON "HandHistory"("handId");
