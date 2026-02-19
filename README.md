# Chat na Mesa - Implementação Completa

Sistema de chat em tempo real para mesas de poker com Redis (cache) + PostgreSQL (persistência).

---

## 🎯 Features

✅ Mensagens em tempo real via Socket.IO
✅ Rate limiting (10 mensagens / 30s)
✅ Histórico persistente (PostgreSQL)
✅ Cache rápido (Redis, últimas 100 msgs)
✅ Sanitização XSS
✅ Timestamps e usernames
✅ Auto-scroll
✅ Unread count badge
✅ Mobile-friendly (floating button)

---

## 📦 Backend - Instalação

### 1. Adicionar modelo ao Prisma

**Arquivo:** `prisma/schema.prisma`

```prisma
model ChatMessage {
  id        String   @id @default(uuid())
  tableId   String
  userId    String
  username  String
  message   String   @db.VarChar(500)
  createdAt DateTime @default(now())

  @@index([tableId, createdAt])
  @@index([userId])
}
```

### 2. Rodar migration

```bash
npx prisma migrate dev --name add_chat_messages
npx prisma generate
```

### 3. Adicionar serviço

Copiar `chat.service.ts` para `src/services/chat.service.ts`

### 4. Integrar handlers no gateway

**Arquivo:** `src/realtime/table.gateway.ts`

```typescript
import { checkChatRateLimit, validateChatMessage, saveChatMessage, getChatHistory } from "../services/chat.service";

export function registerTableGateway(io: Server, socket: Socket) {
  const user = (socket.data as any).user as { userId: string; username: string };

  // ... handlers existentes ...

  // === CHAT HANDLERS ===
  
  socket.on("table:chat:message", async ({ tableId, message }: { tableId: string; message: string }) => {
    try {
      const validation = validateChatMessage(message);
      if (!validation.valid) {
        socket.emit("table:chat:error", { error: validation.error });
        return;
      }

      const allowed = await checkChatRateLimit(tableId, user.userId);
      if (!allowed) {
        socket.emit("table:chat:error", { error: "Você está enviando mensagens muito rápido. Aguarde um momento." });
        return;
      }

      const chatMsg = await saveChatMessage({
        tableId,
        userId: user.userId,
        username: user.username,
        message,
      });

      io.to(`table:${tableId}`).emit("table:chat:message", chatMsg);
    } catch (err: any) {
      console.error("[chat] Send message error:", err);
      socket.emit("table:chat:error", { error: "Erro ao enviar mensagem" });
    }
  });

  socket.on("table:chat:history", async ({ tableId, limit }: { tableId: string; limit?: number }) => {
    try {
      const messages = await getChatHistory(tableId, limit ?? 50);
      socket.emit("table:chat:history", { messages });
    } catch (err: any) {
      console.error("[chat] Get history error:", err);
      socket.emit("table:chat:error", { error: "Erro ao carregar histórico" });
    }
  });
}
```

---

## 🎨 Frontend - Instalação

### 1. Adicionar componente

Copiar `Chat.tsx` para `src/components/Chat.tsx`

### 2. Integrar na página da mesa

**Arquivo:** `app/table/[tableId]/page.tsx`

```typescript
import { Chat } from "../../../src/components/Chat";

function TableInner() {
  // ... código existente ...
  
  return (
    <div className="table-page">
      {/* ... conteúdo existente ... */}
      
      {/* Chat floating */}
      {state && (
        <Chat 
          socket={socket} 
          tableId={tableId} 
          myUserId={me?.userId ?? ""} 
        />
      )}
      
      <ToastManager toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
```

### 3. Adicionar CSS (opcional - já tem inline styles)

Se quiser customizar:

```css
.chat-toggle {
  /* Já tem inline styles, mas pode sobrescrever aqui */
}

.chat-panel {
  /* Já tem inline styles, mas pode sobrescrever aqui */
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

---

## 🔧 Configuração

### Rate Limiting

Ajustar em `chat.service.ts`:

```typescript
const CHAT_RATE_LIMIT = 10; // mensagens
const CHAT_RATE_WINDOW = 30_000; // 30 segundos
```

### Cache Redis

```typescript
const REDIS_CHAT_MAX = 100; // últimas N mensagens
const REDIS_CHAT_TTL = 86400; // 24h
```

### Validação

```typescript
const CHAT_MAX_LENGTH = 500; // caracteres
```

---

## 🧹 Manutenção

### Limpeza de mensagens antigas

Executar 1x/dia via cron:

```typescript
import { cleanOldChatMessages } from "./services/chat.service";

// Apaga mensagens com mais de 30 dias
await cleanOldChatMessages(30);
```

**Exemplo de cron job:**

```typescript
// src/cron/chat-cleanup.ts
import cron from "node-cron";
import { cleanOldChatMessages } from "../services/chat.service";

// Executa todo dia às 3h da manhã
cron.schedule("0 3 * * *", async () => {
  console.log("[cron] Running chat cleanup...");
  const count = await cleanOldChatMessages(30);
  console.log(`[cron] Cleaned ${count} messages`);
});
```

---

## 📊 Monitoramento

### Logs importantes

```typescript
// Rate limit exceeded
console.warn("[chat] Rate limit exceeded", { userId, tableId });

// Mensagens salvas
console.log("[chat] Message saved", { tableId, userId, msgId });

// Erros
console.error("[chat] Redis error:", err);
console.error("[chat] PostgreSQL error:", err);
```

### Métricas recomendadas

- Mensagens enviadas / hora
- Rate limit hits / hora
- Latência de envio (p50, p95, p99)
- Cache hit rate (Redis)

---

## 🚀 Features Futuras (Opcional)

### Fase 2

- **Emojis**: Picker de emojis
- **Menções**: @username com autocomplete
- **Filtro de spam**: Detectar flood/repetição
- **Comandos**: /mute, /report, /clear
- **Moderação**: Banimento temporário
- **Notificações**: Som quando mencionado

### Fase 3

- **Reações**: 👍 ❤️ 😂 nas mensagens
- **Anexos**: Imagens/GIFs (com moderação)
- **Privado**: DMs entre jogadores
- **Histórico público**: API para ver chat de outras mesas

---

## 🐛 Troubleshooting

### Chat não aparece

1. Verificar se socket está conectado
2. Verificar console do browser (erros JS)
3. Verificar console do servidor (erros backend)

### Mensagens não chegam

1. Verificar rate limiting
2. Verificar se está no room correto (`table:${tableId}`)
3. Verificar Redis (deve estar rodando)

### Histórico vazio

1. Verificar migration do Prisma
2. Verificar se PostgreSQL está acessível
3. Verificar logs de erro do serviço

---

## 📝 Checklist de Integração

### Backend
- [ ] Adicionar modelo ChatMessage ao schema.prisma
- [ ] Rodar migration (`npx prisma migrate dev`)
- [ ] Copiar chat.service.ts para src/services/
- [ ] Adicionar handlers no table.gateway.ts
- [ ] Testar com 2 usuários enviando mensagens

### Frontend
- [ ] Copiar Chat.tsx para src/components/
- [ ] Integrar na página da mesa
- [ ] Testar abertura/fechamento do chat
- [ ] Testar envio de mensagens
- [ ] Testar rate limiting (enviar 11 msgs rápido)

### Produção
- [ ] Configurar cron de limpeza
- [ ] Configurar monitoramento de logs
- [ ] Testar com múltiplos usuários simultâneos
- [ ] Verificar performance do Redis/PostgreSQL

---

**Status**: ✅ Pronto para integração

**Tempo de integração estimado**: 15-30 minutos

**Complexidade**: Baixa (plug-and-play)
