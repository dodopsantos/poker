"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTables = listTables;
const prisma_1 = require("../prisma");
async function listTables() {
    const tables = await prisma_1.prisma.table.findMany({
        where: { status: { in: ["OPEN", "RUNNING"] } },
        orderBy: { createdAt: "desc" },
        include: { seats: true },
    });
    return tables.map((t) => ({
        id: t.id,
        name: t.name,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        maxPlayers: t.maxPlayers,
        status: t.status,
        players: t.seats.filter((s) => s.userId).length,
    }));
}
