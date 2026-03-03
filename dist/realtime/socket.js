"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSocketServer = buildSocketServer;
const socket_io_1 = require("socket.io");
const auth_1 = require("../auth");
const lobby_gateway_1 = require("./lobby.gateway");
const table_gateway_1 = require("./table.gateway");
function buildSocketServer(httpServer) {
    const io = new socket_io_1.Server(httpServer, {
        cors: { origin: process.env.CORS_ORIGIN ?? "*" },
    });
    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token ||
                (socket.handshake.headers.authorization?.toString().replace("Bearer ", "") ?? "");
            if (!token)
                return next(new Error("UNAUTHORIZED"));
            const user = (0, auth_1.verifyJwt)(token);
            socket.data.user = user;
            next();
        }
        catch {
            next(new Error("UNAUTHORIZED"));
        }
    });
    io.on("connection", (socket) => {
        const user = socket.data.user;
        socket.join(`user:${user.userId}`);
        (0, lobby_gateway_1.registerLobbyGateway)(io, socket);
        (0, table_gateway_1.registerTableGateway)(io, socket);
    });
    return io;
}
