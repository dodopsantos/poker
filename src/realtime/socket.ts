import { Server } from "socket.io";
import { verifyJwt } from "../auth";
import { registerLobbyGateway } from "./lobby.gateway";
import { registerTableGateway } from "./table.gateway";

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
    });

    return io;
}
