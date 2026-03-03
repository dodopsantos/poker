-- Migration: Add lastRecharge field to User table

-- Adicionar coluna lastRecharge
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRecharge" TIMESTAMP(3);

-- Criar índice (opcional, para performance)
CREATE INDEX IF NOT EXISTS "User_lastRecharge_idx" ON "User"("lastRecharge");

-- Comentário
COMMENT ON COLUMN "User"."lastRecharge" IS 'Timestamp of last wallet recharge';
