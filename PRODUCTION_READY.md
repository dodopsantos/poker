# Poker Backend - Production Ready

Versão completa com correções de bugs críticos, rate limiting, logging estruturado, hand history e JWT com blacklist.

---

## 🐛 Bugs Corrigidos

### Timer Bugs (3 bugs encadeados)

**Bug 1 — Race condition no `table:sit`**
- **Causa**: Duas chamadas `void scheduleTurnTimer` simultâneas no mesmo handler, criando dois timers concorrentes
- **Impacto**: Timer às vezes não disparava no preflop, travando o turno no primeiro jogador
- **Fix**: Consolidado em uma única chamada `await scheduleTurnTimer` no final do handler

**Bug 2 — Timer não criado após virada de street**
- **Causa**: `revealPendingBoard` setava `turnEndsAt` mas não chamava `scheduleTurnTimer`, assumindo que `runAutoRunout` faria isso — mas `runAutoRunout` só chama em modo auto-runout (all-in)
- **Impacto**: Após revelar flop/turn/river, o turno travava indefinidamente
- **Fix**: `revealPendingBoard` agora chama `await scheduleTurnTimer` ao final quando não está em auto-runout

**Bug 3 — Competição entre timers**
- **Causa**: Bloco fire-and-forget `void (async () => { revealPendingBoard })()` executava em paralelo com `await scheduleTurnTimer` final, cancelando timers mutuamente
- **Impacto**: Inconsistência no agendamento de timers após ações
- **Fix**: Bifurcação explícita — se há `pendingBoard`, delega todo o fluxo para o bloco assíncrono; se não, chama `scheduleTurnTimer` diretamente

### Regras de Poker (3 violações oficiais - corrigidas anteriormente)

- HU postflop: dealer (SB) age primeiro (estava invertido)
- Sub-raise all-in: não reabre ação para quem já agiu (estava reabrindo)
- Odd chip: vai para o jogador à esquerda do dealer (estava indo para o menor seatNo)

---

## 🛡️ Segurança & Infraestrutura

### ✅ Rate Limiting (Completo)

**HTTP (via Redis sorted sets):**
- `/auth/register`, `/auth/login`: 5 req / 60s
- `/auth/logout`: sem limite (autenticado)
- `POST /tables`: 10 req / 60s + autenticação obrigatória
- API geral: 100 req / 60s

**Socket.IO (via Redis sorted sets):**
- `table:action`: 20 req / 10s (leniente para gameplay rápido)
- `table:sit`, `table:leave`: 5 req / 30s
- `table:join`: 10 req / 30s (reconexões)
- `table:rebuy`: 5 req / 60s

**Implementação:**
- `src/middleware/rate-limit.ts`: Módulo genérico Redis-based
- Fail-open: em caso de falha do Redis, permite requisição (disponibilidade > restrição)
- Headers: `Retry-After` no 429 Too Many Requests

### ✅ Validação de Env Vars

**Obrigatórias:**
- `DATABASE_URL`: PostgreSQL connection string válida
- `REDIS_URL`: Redis connection string válida
- `JWT_SECRET`: Mínimo 32 caracteres

**Opcionais com fallbacks:**
- `PORT` (default: 3001)
- `CORS_ORIGIN` (default: http://localhost:3000)
- `TURN_TIME_MS` (default: 15000)
- `AWAY_TIMEOUTS_IN_ROW` (default: 2)
- `NODE_ENV` (default: development)

**Boot:**
- Validação com Zod no início do `index.ts` (antes de qualquer import)
- Fail-fast com mensagens claras se variáveis inválidas
- Log mascarado de config (esconde passwords em URLs)

### ✅ JWT com Blacklist (7 dias + revogação)

**Estratégia:** Medium-lived JWT (7 dias) com blacklist no Redis

**Implementação:**
- `signJwt`: JWT com exp=7d
- `verifyJwt`: Verifica assinatura + expiry
- `blacklistToken`: Adiciona token ao Redis com TTL = tempo restante até expiração
- `isTokenBlacklisted`: Verifica Redis antes de aceitar token
- `requireAuth` middleware: Verifica blacklist primeiro, depois valida JWT

**Rota de logout:**
```
POST /auth/logout
Authorization: Bearer <token>
→ Token adicionado ao blacklist no Redis
```

**Fail-open:** Se Redis falhar, permite token (disponibilidade)

### ✅ POST /tables Autenticado

- Middleware `requireAuth` obrigatório
- Validação de parâmetros (blinds, maxPlayers)
- Rate limiting (10 req / 60s)
- **TODO produção:** Restringir a admins (adicionar campo `isAdmin` ao User)

---

## 📊 Observabilidade & Audit

### ✅ Hand History (Banco de dados)

**Modelo Prisma:**
```prisma
model HandHistory {
  id         String   @id @default(uuid())
  tableId    String
  handId     String   // runtime handId
  dealerSeat Int
  smallBlind Int
  bigBlind   Int
  players    Json     // [{seatNo, userId, startStack, endStack, committed, hasFolded}]
  board      Json     // [cards]
  result     Json     // {type: "fold"|"showdown", winners, reveal}
  actions    Json?    // [{round, seatNo, action, amount}] (opcional)
  createdAt  DateTime @default(now())
}
```

**Uso:**
- Salvamento automático ao fim de cada mão (fold ou showdown)
- Não-bloqueante: não impacta performance do jogo
- API: `getTableHandHistory(tableId)` e `getHandById(handId)`

**TODO:**
- Capturar `actions` log durante a mão (requer instrumentação no `applyTableAction`)
- Rota HTTP para consulta de histórico

### ✅ Log Estruturado

**Módulo:** `src/lib/logger.ts`

**Formato:**
- **Development:** Human-readable com timestamp
- **Production:** JSON para log aggregators (CloudWatch, Datadog, etc)

**Níveis:** debug | info | warn | error (configurável via `LOG_LEVEL`)

**Eventos especializados:**
- `handStarted(tableId, handId, players)`
- `handEnded(tableId, handId, winners)`
- `playerAction(tableId, handId, userId, seatNo, action, amount?, timeout?)`
- `playerJoined(tableId, userId, seatNo?)`
- `playerLeft(tableId, userId, cashout?)`
- `rateLimit(identifier, key)`
- `authFailure(ip, username?)`

**Aplicação:**
- Handlers críticos: join, action, hand start/end
- Rate limit violations
- Auth failures

---

## 🎮 Gameplay Features (Já Implementados)

### Timer Recovery
- Boot scan: Redis SCAN para encontrar runtimes ativos
- Re-agendamento automático de timers perdidos após crash/restart

### Reconexão Resiliente
- Auto-rejoin: Ao conectar, verifica se usuário está em mesa RUNNING
- Re-envia state + cartas privadas automaticamente

### Buy-in Validation
- Min: 20x BB
- Max: 100x BB
- Validação atômica com wallet

### Rebuy
- Apenas entre mãos (ou após fold)
- Max stack: 100x BB
- Validação de saldo

### Sit-out
- Auto-fold/check sem incrementar strike
- Campo `isSittingOut` no runtime
- Eventos `table:sit_out` / `table:sit_in`

### Stack Mínimo
- Mínimo: 1x BB para entrar na mão
- Auto-cashout silencioso de jogadores abaixo do mínimo

### Leave Seguro
- Se em mão ativa: enfileira no `pendingKick`
- Cashout no fim da mão ou virada de street

### Graceful Shutdown
- `SIGTERM`/`SIGINT` handlers
- Timeout de 10s para connections fecharem
- Desconexão limpa do Prisma

---

## 📋 Migrations Pendentes

**Executar no banco:**

```bash
npx prisma migrate dev --name add_hand_history
```

Ou criar migration manualmente:

```sql
CREATE TABLE "HandHistory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tableId" TEXT NOT NULL,
  "handId" TEXT NOT NULL,
  "dealerSeat" INTEGER NOT NULL,
  "smallBlind" INTEGER NOT NULL,
  "bigBlind" INTEGER NOT NULL,
  "players" JSONB NOT NULL,
  "board" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "actions" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "HandHistory_tableId_createdAt_idx" ON "HandHistory"("tableId", "createdAt");
CREATE INDEX "HandHistory_handId_idx" ON "HandHistory"("handId");
```

---

## 🚀 Deploy Checklist

- [ ] Configurar variáveis de ambiente (`.env` ou secrets)
- [ ] Rodar migrations do Prisma
- [ ] Configurar Redis (persistência recomendada)
- [ ] Configurar log aggregation (CloudWatch, Datadog, etc)
- [ ] Rate limiting: ajustar limites conforme tráfego esperado
- [ ] POST /tables: restringir a admins
- [ ] Monitoramento: alertas para rate limit, auth failures, hand history save failures

---

## 📈 Melhorias Futuras (Não Implementadas)

**#13 — Testes automatizados**
- Unit tests para `isRoundSettled`, `shouldAutoRunout`, `resolveShowdown`
- Integration tests para timer recovery
- E2E tests para fluxo completo de mão

**Anti-cheat:**
- Detecção de bot farming (tempo de ação anormal)
- Multi-accounting detection
- Collusion detection (via hand history analysis)

**Observers/spectators:**
- Modo read-only para assistir mesas
- Delay de X segundos no estado para prevenir ghosting

**Analytics:**
- Dashboards de métricas (hands/hour, avg pot, rake)
- Player stats (VPIP, PFR, aggression)

---

## 🛠️ Arquivos Modificados/Criados

**Novos:**
- `src/middleware/rate-limit.ts` (rate limiting)
- `src/config/env.ts` (env validation)
- `src/lib/logger.ts` (structured logging)
- `src/services/hand-history.service.ts` (hand history)
- `src/poker/timer-recovery.ts` (boot recovery)

**Modificados:**
- `src/index.ts` (rate limiters, env validation, logout, requireAuth)
- `src/auth.ts` (blacklist)
- `src/realtime/table.gateway.ts` (timer fixes, rate limiting, logging, hand history)
- `src/realtime/socket.ts` (auto-rejoin, io return)
- `src/poker/runtime.ts` (turnEndsAt, stack min)
- `src/services/table.service.ts` (buy-in validation, rebuy, isSittingOut)
- `prisma/schema.prisma` (HandHistory model)

**Versionamento:** 
- Timer fixes: v1.1.0
- Production infra: v2.0.0

---

**Status:** ✅ Pronto para produção (com migrations executadas)
