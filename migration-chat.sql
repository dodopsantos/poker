-- Chat messages schema
-- Run: npx prisma migrate dev --name add_chat_messages

CREATE TABLE "ChatMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tableId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ChatMessage_tableId_createdAt_idx" ON "ChatMessage"("tableId", "createdAt");
CREATE INDEX "ChatMessage_userId_idx" ON "ChatMessage"("userId");
