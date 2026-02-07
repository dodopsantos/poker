import type { Server, Socket } from "socket.io";
import { getOrBuildTableState, sitWithBuyIn, leaveWithCashout } from "../services/table.service";
import { ensureWallet } from "../services/wallet.service";

export function registerTableGateway(io: Server, socket: Socket) {
    const user = (socket.data as any).user as { userId: string; username: string };

    socket.on("table:join", async ({ tableId }: { tableId: string }) => {
        await ensureWallet(user.userId);
        socket.join(`table:${tableId}`);
        const state = await getOrBuildTableState(tableId);
        socket.emit("table:state", state);
    });

    socket.on(
        "table:sit",
        async ({ tableId, seatNo, buyInAmount }: { tableId: string; seatNo: number; buyInAmount: number }) => {
            try {
                const state = await sitWithBuyIn({ tableId, userId: user.userId, seatNo, buyInAmount });
                io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state });
                io.to("lobby").emit("lobby:table_updated", { tableId }); // client pode re-fetch ou receber payload mais rico
            } catch (e: any) {
                socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not sit." });
            }
        }
    );

    socket.on("table:leave", async ({ tableId }: { tableId: string }) => {
        try {
            const newState = await leaveWithCashout({ tableId, userId: user.userId });
            io.to(`table:${tableId}`).emit("table:event", { type: "STATE_SNAPSHOT", tableId, state: newState });
            io.to("lobby").emit("lobby:table_updated", { tableId });
        } catch (e: any) {
            socket.emit("table:event", { type: "ERROR", code: e.message ?? "UNKNOWN", message: "Could not leave." });
        }
    });
}
