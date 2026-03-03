# Poker Backend

Backend do sistema de poker online com Node.js, Express, Socket.IO e PostgreSQL.

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Configurar .env
# Editar .env com suas credenciais

# 3. Rodar migrations
npx prisma migrate deploy
npx prisma generate

# 4. Iniciar servidor
npm run dev
```

## Endpoints Principais

- `POST /auth/register` - Registrar usuário
- `POST /auth/login` - Login
- `GET /wallet` - Ver saldo
- `POST /wallet/recharge` - Recarregar saldo
- `POST /wallet/daily-bonus` - Coletar bônus diário
- `GET /profile/me` - Ver perfil
- `GET /tables` - Listar mesas
- Socket.IO para gameplay em tempo real

## Variáveis de Ambiente

```
DATABASE_URL="postgresql://user:password@localhost:5432/poker_db"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="your-secret-key-min-32-chars"
PORT=3001
```
