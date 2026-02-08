"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const socket_1 = require("./realtime/socket");
const prisma_1 = require("./prisma");
const bcrypt_1 = __importDefault(require("bcrypt"));
const zod_1 = require("zod");
const auth_1 = require("./auth");
const wallet_service_1 = require("./services/wallet.service");
const app = (0, express_1.default)();
const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
app.use((0, cors_1.default)({
    origin: allowedOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use((req, res, next) => {
    // Preflight request
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
app.use(express_1.default.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
// -----------------
// Auth (MVP simples)
// -----------------
const authBodySchema = zod_1.z.object({
    username: zod_1.z.string().min(3).max(32),
    password: zod_1.z.string().min(6).max(128),
});
app.post("/auth/register", async (req, res) => {
    const parsed = authBodySchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const { username, password } = parsed.data;
    const existing = await prisma_1.prisma.user.findUnique({ where: { username } });
    if (existing) {
        return res.status(409).json({ error: "USERNAME_TAKEN" });
    }
    const passwordHash = await bcrypt_1.default.hash(password, 10);
    const user = await prisma_1.prisma.user.create({
        data: { username, passwordHash },
        select: { id: true, username: true },
    });
    const wallet = await prisma_1.prisma.wallet.create({
        data: { userId: user.id, balance: 10000 },
        select: { balance: true },
    });
    const token = (0, auth_1.signJwt)({ userId: user.id, username: user.username });
    return res.json({ token, user, wallet });
});
app.post("/auth/login", async (req, res) => {
    const parsed = authBodySchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const { username, password } = parsed.data;
    const user = await prisma_1.prisma.user.findUnique({ where: { username } });
    if (!user) {
        return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }
    const ok = await bcrypt_1.default.compare(password, user.passwordHash);
    if (!ok) {
        return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }
    await (0, wallet_service_1.ensureWallet)(user.id);
    const wallet = await prisma_1.prisma.wallet.findUnique({
        where: { userId: user.id },
        select: { balance: true },
    });
    const token = (0, auth_1.signJwt)({ userId: user.id, username: user.username });
    return res.json({ token, user: { id: user.id, username: user.username }, wallet });
});
function requireAuth(req, res, next) {
    try {
        const header = req.headers.authorization?.toString() ?? "";
        const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        if (!token)
            return res.status(401).json({ error: "UNAUTHORIZED" });
        const user = (0, auth_1.verifyJwt)(token);
        req.user = user;
        return next();
    }
    catch {
        return res.status(401).json({ error: "UNAUTHORIZED" });
    }
}
app.get("/wallet", requireAuth, async (req, res) => {
    const user = req.user;
    await (0, wallet_service_1.ensureWallet)(user.userId);
    const wallet = await prisma_1.prisma.wallet.findUnique({
        where: { userId: user.userId },
        select: { balance: true },
    });
    return res.json({ wallet });
});
app.get("/tables", async (_req, res) => {
    const tables = await prisma_1.prisma.table.findMany({
        where: { status: { in: ["OPEN", "RUNNING"] } },
        orderBy: { createdAt: "desc" },
        include: { seats: true },
    });
    return res.json(tables.map((t) => ({
        id: t.id,
        name: t.name,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        maxPlayers: t.maxPlayers,
        status: t.status,
        players: t.seats.filter((s) => s.userId).length,
    })));
});
// (Opcional) init seats ao criar mesa
app.post("/tables", async (req, res) => {
    const { name, smallBlind, bigBlind, maxPlayers } = req.body;
    const table = await prisma_1.prisma.table.create({
        data: {
            name,
            smallBlind,
            bigBlind,
            maxPlayers,
            seats: {
                create: Array.from({ length: maxPlayers }).map((_, i) => ({
                    seatNo: i + 1,
                    state: "EMPTY",
                    stack: 0,
                })),
            },
        },
        include: { seats: true },
    });
    res.json(table);
});
const server = http_1.default.createServer(app);
(0, socket_1.buildSocketServer)(server);
server.listen(process.env.PORT ?? 3001, () => {
    console.log(`API listening on :${process.env.PORT ?? 3001}`);
});
