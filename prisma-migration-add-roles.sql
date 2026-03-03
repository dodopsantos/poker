-- Migration: Add user roles and daily bonus

-- Adicionar coluna role no User (se não existir)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'USER';

-- Adicionar campo lastDailyBonus (para controlar bonus diário)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastDailyBonus" TIMESTAMP(3);

-- Criar índice
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");

-- Dar role ADMIN para o primeiro usuário (opcional)
-- UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1);

COMMENT ON COLUMN "User"."role" IS 'USER or ADMIN';
COMMENT ON COLUMN "User"."lastDailyBonus" IS 'Timestamp of last daily bonus claim';
