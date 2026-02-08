"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLobbyGateway = registerLobbyGateway;
const lobby_service_1 = require("../services/lobby.service");
function registerLobbyGateway(io, socket) {
    socket.on("lobby:join", async () => {
        socket.join("lobby");
        const tables = await (0, lobby_service_1.listTables)();
        socket.emit("lobby:tables", tables);
    });
}
