import { Server } from "socket.io";
import { verifyJwt } from "../auth";
import { registerLobbyGateway } from "./lobby.gateway";
import { registerTableGateway, scheduleTurnTimer } from "./table.gateway";
import { prisma } from "../prisma";
import { getRuntime, getPrivateCards } from "../poker/runtime";
import { getOrBuildTableState } from "../services/table.service";

export function buildSocketServer(httpServer: any) {
    const io = new Server(httpServer, {
        cors: { origin: process.env.CORS_ORIGIN ?? "*" },
    });

    io.use((socket, next) => {
        try {
            const token =
                socket.handshake.auth?.token ||
                (socket.handshake.headers.authorization?.toString().replace("Bearer ", "") ?? "");

            if (!token) return next(new Error("UNAUTHORIZED"));
            const user = verifyJwt(token);
            (socket.data as any).user = user;
            next();
        } catch {
            next(new Error("UNAUTHORIZED"));
        }
    });

    io.on("connection", (socket) => {
        const user = (socket.data as any).user as { userId: string; username: string };
        socket.join(`user:${user.userId}`);

        registerLobbyGateway(io, socket);
        registerTableGateway(io, socket);

        // Auto-rejoin: if the user is seated at an active table, restore their session
        // without requiring the client to re-emit table:join.
        // This handles reconnection after server restart or network drop.
        void autoRejoinActiveTable(io, socket, user.userId);
    });

    return io;
}

/**
 * On reconnection, checks if the user is seated at any RUNNING table.
 * If so, silently rejoins the socket room and re-sends their private cards + state.
 * The client can detect this via the STATE_SNAPSHOT event and restore the UI.
 */
async function autoRejoinActiveTable(
    io: Server,
    socket: any,
    userId: string
): Promise<void> {
    try {
        // Find the seat this user occupies (if any) at a running table.
        const seat = await prisma.tableSeat.findFirst({
            where: {
                userId,
                state: "PLAYING",
                table: { status: "RUNNING" },
            },
            include: { table: true },
        });

        if (!seat) return;

        const tableId = seat.tableId;
        const rt = await getRuntime(tableId);
        if (!rt) return;

        // Rejoin the socket room.
        socket.join(`table:${tableId}`);

        // Send current state.
        const state = await getOrBuildTableState(tableId);
        socket.emit("table:state", state);

        // Re-send private cards so the client can show the player's hole cards.
        const cards = await getPrivateCards(tableId, rt.handId, userId);
        if (cards) {
            socket.emit("table:private_cards", {
                tableId,
                handId: rt.handId,
                cards,
            });
        }

        // Ensure the turn timer is running (important after server restart).
        void scheduleTurnTimer(io, tableId);

        console.log(`[reconnect] userId=${userId} auto-rejoined tableId=${tableId}`);
    } catch (err) {
        // Non-critical: log and continue. The user can manually rejoin.
        console.error("[reconnect] autoRejoinActiveTable failed:", err);
    }
}
