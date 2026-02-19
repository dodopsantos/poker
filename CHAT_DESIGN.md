# Chat na Mesa - Design

## Arquitetura

### Backend
- Socket.IO events: `table:chat:message`, `table:chat:history`
- Storage: Redis (mensagens recentes) + PostgreSQL (histórico permanente)
- Rate limiting: 10 mensagens / 30s por usuário
- Moderação: Filtro de palavrões básico, banimento temporário

### Database Schema
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

### Redis Structure
- Key: `chat:${tableId}`
- Type: List (LPUSH + LTRIM)
- Max: 100 mensagens recentes
- TTL: 24h após última mensagem

## Features

### MVP
- ✅ Mensagens de texto simples
- ✅ Rate limiting
- ✅ Histórico (últimas 50 msgs ao entrar)
- ✅ Username display
- ✅ Timestamps
- ✅ Auto-scroll

### Fase 2 (opcional)
- Emojis
- Menções (@username)
- Filtro de spam/flood
- Comandos (/mute, /report)

## Events

### Client → Server
```typescript
socket.emit("table:chat:message", { tableId, message });
socket.emit("table:chat:history", { tableId, limit: 50 });
```

### Server → Client
```typescript
socket.emit("table:chat:message", { 
  id, tableId, userId, username, message, timestamp 
});
socket.emit("table:chat:history", { messages: [...] });
```

## Rate Limiting
- 10 mensagens / 30s
- Cooldown visual no frontend
- Mensagem de erro clara

## Validação
- Max 500 caracteres
- Trim whitespace
- Rejeita mensagens vazias
- Sanitização básica (XSS)
