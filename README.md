# Poker (MVP)

Backend MVP for a poker lobby + tables (cash game) using:
- Node.js + Express
- Socket.IO (real-time)
- PostgreSQL + Prisma
- Redis (cache/state)

## Setup (local)

1) Copy env file:

```bash
cp .env.example .env
```

2) Configure `DATABASE_URL` (PostgreSQL) and start Redis.

3) Prisma migrate + generate:

```bash
npm run prisma:migrate
npm run prisma:generate
```

4) Run:

```bash
npm run dev
```

## Auth (MVP)

- `POST /auth/register` { username, password }
- `POST /auth/login` { username, password }

Use the returned JWT token in Socket.IO handshake:

```js
const socket = io("http://localhost:3001", { auth: { token } });
```

## Lobby / Table events

Lobby:
- client -> `lobby:join`
- server -> `lobby:tables`

Table:
- client -> `table:join` { tableId }
- server -> `table:state`
- client -> `table:sit` { tableId, seatNo, buyInAmount }
- client -> `table:leave` { tableId }
- server -> `table:event` (STATE_SNAPSHOT / ERROR)
