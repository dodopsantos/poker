# Sistema de Wallet e Roles - Implementado

Sistema completo de gerenciamento de moedas, bônus diário e roles de usuário.

---

## ✅ Funcionalidades Implementadas

### 1. Sistema de Roles (USER / ADMIN)

**Backend:**
- ✅ Campo `role` adicionado ao modelo User
- ✅ Padrão: "USER"
- ✅ Campo `lastDailyBonus` para controlar bonus diário
- ✅ Role retornado no login/register

**Frontend:**
- ✅ Role salvo no localStorage
- ✅ Botão "Criar Mesa" visível apenas para ADMIN
- ✅ Interface adapta baseado na role

---

### 2. Bônus Diário

**Backend - Endpoints:**
```typescript
POST /wallet/daily-bonus
GET /wallet/daily-bonus/status
```

**Mecânica:**
- 1000 moedas grátis por dia
- Cooldown de 24 horas
- Validação server-side

**Frontend:**
- ✅ Widget no lobby mostrando status
- ✅ Botão para coletar (quando disponível)
- ✅ Timer mostrando horas restantes
- ✅ Animação de sucesso ao coletar
- ✅ Atualiza saldo automaticamente

---

### 3. Add Coins (Admin Only)

**Backend:**
```typescript
POST /wallet/add-coins
Body: { targetUserId, amount }
Auth: requireAuth + role === "ADMIN"
```

**Funcionalidade:**
- Admin pode adicionar moedas para qualquer usuário
- Validações:
  - Apenas admins
  - Amount entre 1 e 1.000.000
  - User existe

---

### 4. Restrição de Criação de Mesas

**Backend:**
- ✅ Endpoint POST /tables agora verifica role
- ✅ Apenas ADMIN pode criar mesas
- ✅ Retorna 403 FORBIDDEN para users normais

**Frontend:**
- ✅ Botão "Criar Mesa" escondido para users normais
- ✅ Apenas ADMIN vê o botão

---

## 📦 Estrutura de Dados

### User Model (Prisma)

```prisma
model User {
  id              String    @id @default(uuid())
  username        String    @unique
  passwordHash    String
  role            String    @default("USER")  // USER ou ADMIN
  lastDailyBonus  DateTime?
  createdAt       DateTime  @default(now())
  
  wallet         Wallet?
  stats          PlayerStats?
  dailyStats     DailyStats[]
  
  @@index([role])
}
```

---

## 🔌 API Endpoints

### Daily Bonus

**POST /wallet/daily-bonus**
```bash
curl -X POST http://localhost:3001/wallet/daily-bonus \
  -H "Authorization: Bearer TOKEN"
```

**Response (Success):**
```json
{
  "success": true,
  "bonus": 1000,
  "balance": 5000,
  "nextBonusIn": 24
}
```

**Response (Already Claimed):**
```json
{
  "error": "DAILY_BONUS_CLAIMED",
  "message": "Você já coletou seu bônus diário. Próximo em 18h.",
  "hoursRemaining": 18
}
```

---

**GET /wallet/daily-bonus/status**
```bash
curl http://localhost:3001/wallet/daily-bonus/status \
  -H "Authorization: Bearer TOKEN"
```

**Response:**
```json
{
  "canClaim": true,
  "hoursRemaining": 0,
  "bonusAmount": 1000
}
```

---

### Add Coins (Admin)

**POST /wallet/add-coins**
```bash
curl -X POST http://localhost:3001/wallet/add-coins \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetUserId": "user-uuid",
    "amount": 5000
  }'
```

**Response (Success):**
```json
{
  "success": true,
  "amount": 5000,
  "newBalance": 10000
}
```

**Response (Not Admin):**
```json
{
  "error": "FORBIDDEN",
  "message": "Only admins can add coins"
}
```

---

### Create Table (Admin Only)

**POST /tables**
```bash
curl -X POST http://localhost:3001/tables \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High Stakes",
    "smallBlind": 50,
    "bigBlind": 100,
    "maxPlayers": 6
  }'
```

**Response (Not Admin):**
```json
{
  "error": "FORBIDDEN",
  "message": "Only admins can create tables"
}
```

---

## 🗄️ Migrations

### 1. Adicionar Roles

```sql
-- Executar manualmente ou via Prisma migrate
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'USER';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastDailyBonus" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");
```

### 2. Tornar Usuário Admin

```sql
-- Tornar o primeiro usuário admin
UPDATE "User" 
SET "role" = 'ADMIN' 
WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1);

-- OU por username
UPDATE "User" SET "role" = 'ADMIN' WHERE "username" = 'admin';
```

---

## 🧪 Como Testar

### Teste 1: Daily Bonus

1. Fazer login
2. Ir para lobby
3. Ver widget "🎁 Bônus Diário"
4. Clicar em "Coletar"
5. Ver "+1000 moedas coletadas!"
6. Saldo atualiza automaticamente
7. Widget mostra "Próximo bônus em 24h"

### Teste 2: Restrição de Criar Mesa

**Como USER:**
1. Login como user normal
2. Ir para lobby
3. Botão "Criar Mesa" NÃO aparece ✅

**Como ADMIN:**
1. Login como admin
2. Ir para lobby
3. Botão "Criar Mesa" aparece ✅
4. Clicar e criar mesa funciona ✅

### Teste 3: Add Coins (via API)

```bash
# 1. Login como admin e pegar token
TOKEN="..."

# 2. Buscar ID de um usuário
USER_ID="..."

# 3. Adicionar moedas
curl -X POST http://localhost:3001/wallet/add-coins \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetUserId":"'$USER_ID'","amount":5000}'

# 4. Verificar saldo do usuário aumentou
```

---

## 🎨 UI/UX

### Daily Bonus Widget

```
┌─────────────────────────────────────┐
│ 🎁 Bônus Diário        [Coletar]   │
│ Ganhe 1,000 moedas grátis!         │
└─────────────────────────────────────┘
```

**Após coletar:**
```
┌─────────────────────────────────────┐
│ 🎁 Bônus Diário         [18h]      │
│ Próximo bônus em 18h               │
│                                     │
│ ✅ +1,000 moedas coletadas!        │
└─────────────────────────────────────┘
```

### Lobby - User vs Admin

**USER (normal):**
```
┌─────────────────────────────────────┐
│ [🃏 Histórico] [🏆 Rankings] [Sair]│
│                                     │
│ Saldo: 5,000                        │
│                                     │
│ 🎁 Bônus Diário        [Coletar]   │
└─────────────────────────────────────┘
```

**ADMIN:**
```
┌─────────────────────────────────────┐
│ [🃏 Histórico] [🏆 Rankings]       │
│ [+ Criar Mesa] [Sair]              │
│                                     │
│ Saldo: 10,000                       │
└─────────────────────────────────────┘
```

---

## 🔒 Segurança

### Validações Backend

1. **Daily Bonus:**
   - ✅ Verifica timestamp no servidor
   - ✅ Não confia no frontend
   - ✅ Usa transação para evitar race conditions

2. **Add Coins:**
   - ✅ Verifica role ADMIN
   - ✅ Valida amount (1 - 1.000.000)
   - ✅ Verifica se target user existe

3. **Create Table:**
   - ✅ Verifica role ADMIN
   - ✅ Rate limit já existente
   - ✅ Validações de blinds/players

---

## 🚀 Deploy

### Backend

```bash
cd backend

# 1. Instalar dependências
npm install

# 2. Rodar migration (adicionar roles)
npx prisma migrate dev --name add_user_roles

# 3. OU executar SQL manualmente
psql $DATABASE_URL < prisma-migration-add-roles.sql

# 4. Tornar primeiro usuário admin
psql $DATABASE_URL -c "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"id\" = (SELECT \"id\" FROM \"User\" ORDER BY \"createdAt\" LIMIT 1);"

# 5. Start
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## 📈 Melhorias Futuras

### 1. Premium/VIP System
- Bônus diário maior (2000 moedas)
- Cooldown menor (12h)
- Acesso a mesas exclusivas

### 2. Streak Bonus
- Dia 1: 1000
- Dia 2: 1200
- Dia 3: 1500
- Dia 7: 5000

### 3. Admin Panel
- Interface web para add coins
- Ver todos os usuários
- Gerenciar roles
- Ver estatísticas

### 4. Shop System
- Comprar moedas (monetização)
- Avatars
- Temas

---

## 🐛 Troubleshooting

### "Botão criar mesa não aparece mesmo sendo admin"

**Solução:**
1. Verificar role no banco:
```sql
SELECT "id", "username", "role" FROM "User" WHERE "username" = 'SEU_USERNAME';
```

2. Fazer logout e login novamente
3. Verificar localStorage:
```javascript
JSON.parse(localStorage.getItem('poker_user'))
```

### "Daily bonus não funciona"

**Verificar:**
```sql
SELECT "username", "lastDailyBonus" FROM "User";
```

**Reset manual:**
```sql
UPDATE "User" SET "lastDailyBonus" = NULL WHERE "username" = 'test';
```

---

**Status:** ✅ Sistema completo e funcional

**Features:**
- ✅ Daily Bonus (1000 moedas/dia)
- ✅ Roles (USER/ADMIN)
- ✅ Add Coins (admin only)
- ✅ Create Table restrito a admin
- ✅ Interface adapta por role
