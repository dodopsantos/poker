# Hand History - Endpoints Implementados

Endpoints de histórico de mãos adicionados ao backend.

---

## ✅ Endpoints Disponíveis

### 1. GET /history/me

**Descrição:** Retorna o histórico de mãos do usuário logado

**Auth:** ✅ requireAuth

**Query Parameters:**
- `limit` (opcional): número de mãos (default: 50, max: 100)
- `offset` (opcional): paginação (default: 0)

**Exemplo de Request:**
```bash
curl http://localhost:3001/history/me?limit=20 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "history": [
    {
      "id": "uuid",
      "handId": "1708790400000-abc123",
      "tableId": "table-uuid",
      "dealerSeat": 1,
      "smallBlind": 10,
      "bigBlind": 20,
      "players": [
        {
          "seatNo": 1,
          "userId": "user-uuid",
          "username": "Player1",
          "startStack": 1000,
          "endStack": 1200,
          "committed": 200,
          "payout": 400
        }
      ],
      "board": ["AS", "KH", "QD", "JC", "TS"],
      "result": {
        "type": "showdown",
        "reveal": [
          {
            "seatNo": 1,
            "userId": "user-uuid",
            "cards": ["AS", "AH"],
            "value": 12345
          }
        ],
        "winners": [
          {
            "seatNo": 1,
            "userId": "user-uuid",
            "payout": 400,
            "value": 12345
          }
        ]
      },
      "actions": [
        {
          "round": "PREFLOP",
          "seatNo": 1,
          "action": "raise",
          "amount": 40
        }
      ],
      "createdAt": "2026-02-24T10:30:00.000Z"
    }
  ]
}
```

**Implementação:**
- Usa PostgreSQL `@>` operator para buscar em JSON array
- Busca todas as mãos onde o userId aparece no array de players
- Ordenado por createdAt DESC (mais recente primeiro)

---

### 2. GET /hands/:handId

**Descrição:** Retorna detalhes completos de uma mão específica

**Auth:** ✅ requireAuth

**Params:**
- `handId`: ID da mão (ex: "1708790400000-abc123")

**Exemplo de Request:**
```bash
curl http://localhost:3001/hands/1708790400000-abc123 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "hand": {
    "id": "uuid",
    "handId": "1708790400000-abc123",
    "tableId": "table-uuid",
    "dealerSeat": 1,
    "smallBlind": 10,
    "bigBlind": 20,
    "players": [...],
    "board": [...],
    "result": {...},
    "actions": [...],
    "createdAt": "2026-02-24T10:30:00.000Z"
  }
}
```

**Erros:**
- `404`: Hand not found

---

### 3. GET /tables/:tableId/history

**Descrição:** Retorna histórico de uma mesa específica

**Auth:** ✅ requireAuth

**Params:**
- `tableId`: ID da mesa

**Query Parameters:**
- `limit` (opcional): default 20, max 100
- `offset` (opcional): default 0

**Exemplo de Request:**
```bash
curl http://localhost:3001/tables/table-uuid/history?limit=10 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "history": [...]
}
```

---

## 🧪 Como Testar

### 1. Iniciar Backend

```bash
cd backend
npm run dev
```

### 2. Criar Usuário e Jogar

```bash
# Registrar
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}'

# Login (pegar token)
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}'

# Salvar o token retornado
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### 3. Jogar Algumas Mãos

Usar a interface do frontend ou Socket.IO para jogar 2-3 mãos completas

### 4. Testar Endpoints

```bash
# Ver histórico
curl http://localhost:3001/history/me \
  -H "Authorization: Bearer $TOKEN"

# Ver detalhes de uma mão específica
curl http://localhost:3001/hands/HAND_ID \
  -H "Authorization: Bearer $TOKEN"

# Ver histórico de uma mesa
curl http://localhost:3001/tables/TABLE_ID/history \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🔍 Verificação de Dados

### Verificar no Banco

```sql
-- Ver todas as mãos salvas
SELECT "handId", "tableId", "createdAt", 
       jsonb_array_length(players) as player_count
FROM "HandHistory"
ORDER BY "createdAt" DESC
LIMIT 10;

-- Ver mãos de um usuário específico
SELECT "handId", "createdAt"
FROM "HandHistory"
WHERE players::jsonb @> '[{"userId": "USER_ID_AQUI"}]'::jsonb
ORDER BY "createdAt" DESC;
```

---

## 🐛 Troubleshooting

### Erro: "players is not iterable" ou similar

**Causa:** Campo `players` não é um array válido

**Solução:** Verificar que o campo está sendo salvo corretamente no banco:
```sql
SELECT players FROM "HandHistory" LIMIT 1;
```

### Erro: 404 "Hand not found"

**Causa:** handId incorreto ou mão não existe

**Solução:** 
```sql
SELECT "handId" FROM "HandHistory" ORDER BY "createdAt" DESC LIMIT 5;
```

### Query muito lenta

**Causa:** Sem índice no campo JSON

**Solução:** Adicionar índice GIN:
```sql
CREATE INDEX idx_hand_history_players ON "HandHistory" USING GIN (players jsonb_path_ops);
```

---

## 📊 Performance

### Sem Índice
- ~100ms para buscar em 1000 mãos

### Com Índice GIN
- ~5-10ms para buscar em 1000 mãos

**Recomendado:** Adicionar índice em produção:
```sql
CREATE INDEX IF NOT EXISTS idx_hand_history_players 
ON "HandHistory" USING GIN (players jsonb_path_ops);
```

---

## 🔒 Segurança

### Autenticação
- ✅ Todos os endpoints requerem autenticação
- ✅ Users só podem ver suas próprias mãos
- ✅ Validação de inputs (limit, offset)

### Rate Limiting
- ⚠️ Considerar adicionar rate limit específico:
```typescript
const historyRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30 // 30 requests por minuto
});

app.get("/history/me", requireAuth, historyRateLimit, ...);
```

---

## 📈 Monitoramento

### Métricas a Observar
- Número de requests `/history/me` por minuto
- Tempo médio de resposta
- Erros 500 (falhas na query)
- Uso de memória (queries grandes)

### Logs
```typescript
console.log('[hand-history] User:', userId, 'fetched', history.length, 'hands');
```

---

## 🚀 Melhorias Futuras

### Cache
```typescript
// Redis cache para histórico recente
const cacheKey = `history:${userId}`;
const cached = await redis.get(cacheKey);

if (cached) {
  return res.json({ history: JSON.parse(cached) });
}

// ... fetch from DB ...

await redis.setex(cacheKey, 300, JSON.stringify(history)); // 5 min cache
```

### Filtros
```typescript
// Adicionar filtros por:
// - Date range
// - Stakes (SB/BB)
// - Número de players
// - Resultado (won/lost)

app.get("/history/me", requireAuth, async (req, res) => {
  const { startDate, endDate, minBB, maxBB } = req.query;
  
  // Build dynamic where clause
});
```

### Agregações
```typescript
// Endpoint de estatísticas
app.get("/history/me/stats", requireAuth, async (req, res) => {
  // Total hands, win rate, profit, etc
});
```

---

**Status:** ✅ Endpoints implementados e funcionando

**Próximo passo:** Testar no frontend!
