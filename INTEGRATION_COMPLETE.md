# Integração Completa - Wallet System

Sistema de wallet, bônus diário e roles totalmente integrado.

---

## ✅ Status da Integração

### Backend
- ✅ Schema Prisma atualizado (role, lastDailyBonus)
- ✅ Endpoints de wallet implementados
- ✅ Login retorna role do usuário
- ✅ Criação de mesas restrita a admin

### Frontend
- ✅ auth.ts com getUserData/setUserData
- ✅ Login salva user data (incluindo role)
- ✅ Lobby busca e usa role
- ✅ DailyBonus component criado
- ✅ Botão "Criar Mesa" condicional

---

## 🔌 Endpoints Backend

### 1. POST /wallet/daily-bonus
**Status:** ✅ Implementado
**Auth:** requireAuth

### 2. GET /wallet/daily-bonus/status  
**Status:** ✅ Implementado
**Auth:** requireAuth

### 3. POST /wallet/add-coins
**Status:** ✅ Implementado
**Auth:** requireAuth + ADMIN

### 4. POST /tables
**Status:** ✅ Restrito a ADMIN

### 5. POST /auth/login
**Status:** ✅ Retorna user.role

---

## 🚀 Setup Completo

### 1. Backend

```bash
cd backend

# Instalar
npm install

# Configurar .env
cat > .env << 'EOF'
DATABASE_URL="postgresql://postgres:senha@localhost:5432/poker_db"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="seu-secret-aqui-32-chars-minimo"
PORT=3001
EOF

# Criar banco
createdb poker_db

# Gerar Prisma
npx prisma generate

# Rodar migrations
npx prisma migrate deploy

# Iniciar
npm run dev
```

---

### 2. Frontend

```bash
cd frontend

# Instalar
npm install

# Configurar .env.local (se necessário)
echo "NEXT_PUBLIC_API_URL=http://localhost:3001" > .env.local

# Iniciar
npm run dev
```

---

### 3. Criar Admin

```bash
# Após criar usuário via interface:
psql poker_db -c "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"username\" = 'admin';"
```

---

## 🧪 Teste Completo

### Passo 1: Verificar Backend

```bash
# Health check
curl http://localhost:3001/health
# Deve retornar: {"ok":true}

# Registrar usuário
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'

# Login e pegar token
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'
  
# Salvar o token retornado
TOKEN="..."
```

---

### Passo 2: Testar Daily Bonus

```bash
# Ver status
curl http://localhost:3001/wallet/daily-bonus/status \
  -H "Authorization: Bearer $TOKEN"

# Deve retornar:
# {"canClaim":true,"hoursRemaining":0,"bonusAmount":1000}

# Coletar bônus
curl -X POST http://localhost:3001/wallet/daily-bonus \
  -H "Authorization: Bearer $TOKEN"

# Deve retornar:
# {"success":true,"bonus":1000,"balance":11000,"nextBonusIn":24}

# Tentar coletar novamente (deve falhar)
curl -X POST http://localhost:3001/wallet/daily-bonus \
  -H "Authorization: Bearer $TOKEN"

# Deve retornar:
# {"error":"DAILY_BONUS_CLAIMED","message":"...","hoursRemaining":24}
```

---

### Passo 3: Testar Criação de Mesa

**Como USER (deve falhar):**
```bash
curl -X POST http://localhost:3001/tables \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","smallBlind":10,"bigBlind":20,"maxPlayers":6}'

# Deve retornar 403:
# {"error":"FORBIDDEN","message":"Only admins can create tables"}
```

**Como ADMIN (deve funcionar):**
```bash
# 1. Tornar usuário admin
psql poker_db -c "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"username\" = 'test';"

# 2. Fazer novo login para pegar token com role atualizada
TOKEN_ADMIN="..."

# 3. Criar mesa
curl -X POST http://localhost:3001/tables \
  -H "Authorization: Bearer $TOKEN_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name":"VIP Table","smallBlind":50,"bigBlind":100,"maxPlayers":6}'

# Deve retornar 200 com dados da mesa criada
```

---

### Passo 4: Testar Frontend

1. Abrir http://localhost:3000/login
2. Registrar usuário "testuser"
3. Fazer login
4. Ir para lobby
5. Verificar:
   - ✅ Widget "🎁 Bônus Diário" aparece
   - ✅ Botão "Criar Mesa" **NÃO** aparece (USER)
   - ✅ Pode clicar "Coletar" no bônus
   - ✅ Mostra "+1000 moedas coletadas!"

6. Tornar usuário admin:
```bash
psql poker_db -c "UPDATE \"User\" SET \"role\" = 'ADMIN' WHERE \"username\" = 'testuser';"
```

7. Fazer logout e login novamente
8. Verificar:
   - ✅ Botão "Criar Mesa" **aparece**
   - ✅ Pode criar mesas

---

## 🔍 Debug 404 em /wallet/daily-bonus/status

Se o endpoint retorna 404:

### Verificação 1: Backend está rodando?
```bash
curl http://localhost:3001/health
```

### Verificação 2: Endpoint está registrado?
```bash
cd backend/src
grep -n "daily-bonus" index.ts
```

Deve mostrar:
- Linha ~168: POST /wallet/daily-bonus
- Linha ~272: GET /wallet/daily-bonus/status

### Verificação 3: Token é válido?
```javascript
// No console do browser (F12)
localStorage.getItem('poker_token')
```

### Verificação 4: Headers corretos?
```javascript
// No Network tab (F12), verificar request:
// Authorization: Bearer TOKEN
// Content-Type: application/json
```

### Verificação 5: URL correta?
```javascript
// Verificar em .env.local do frontend
NEXT_PUBLIC_API_URL=http://localhost:3001
```

---

## 🐛 Problemas Comuns

### "404 Not Found" no daily-bonus

**Causa possível:** Backend não reiniciou após adicionar endpoints

**Solução:**
```bash
cd backend
npm run dev
# Ctrl+C e reiniciar
```

---

### "Cannot find name 'userRole'"

**Causa:** Frontend não atualizado

**Solução:**
```bash
cd frontend
# Verificar que app/lobby/page.tsx tem:
# - const [userRole, setUserRole] = useState<string>("USER");
# - useEffect que chama getUserData()
```

---

### "User data not found" ao fazer login

**Causa:** Login não está salvando user data

**Solução:**
```bash
# Verificar app/login/page.tsx tem:
# import { setToken, setUserData } from "../../src/lib/auth";
# 
# e após login:
# setUserData(data.user);
```

---

### Botão "Criar Mesa" não aparece para admin

**Causa:** Role não salva ou não carrega

**Solução:**
```javascript
// 1. Verificar no console (F12):
JSON.parse(localStorage.getItem('poker_user'))

// 2. Deve retornar:
{ id: "...", username: "...", role: "ADMIN" }

// 3. Se role não está presente:
// - Fazer logout
// - Verificar role no banco: SELECT role FROM "User" WHERE username = 'user';
// - Fazer login novamente
```

---

## 📊 Queries Úteis

```sql
-- Ver todos os usuários e roles
SELECT username, role, "lastDailyBonus" FROM "User";

-- Tornar usuário admin
UPDATE "User" SET "role" = 'ADMIN' WHERE "username" = 'seu_user';

-- Reset daily bonus (para testar)
UPDATE "User" SET "lastDailyBonus" = NULL WHERE "username" = 'test';

-- Ver wallets
SELECT u.username, w.balance 
FROM "User" u 
JOIN "Wallet" w ON u.id = w."userId";
```

---

## ✅ Checklist Final

### Backend
- [ ] `npm install` executado
- [ ] `.env` configurado
- [ ] Banco criado (`createdb poker_db`)
- [ ] `npx prisma generate`
- [ ] `npx prisma migrate deploy`
- [ ] `npm run dev` rodando sem erros
- [ ] `curl http://localhost:3001/health` retorna `{"ok":true}`
- [ ] Usuário criado e tornado admin

### Frontend  
- [ ] `npm install` executado
- [ ] `npm run dev` rodando
- [ ] http://localhost:3000 abre
- [ ] Login funciona
- [ ] Widget daily bonus aparece
- [ ] Botão criar mesa condicional funciona

---

**Status:** ✅ Sistema completamente integrado e funcional
