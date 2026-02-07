import type { Server, Socket } from "socket.io";
import { listTables } from "../services/lobby.service";

export function registerLobbyGateway(io: Server, socket: Socket) {
  socket.on("lobby:join", async () => {
    socket.join("lobby");
    const tables = await listTables();
    socket.emit("lobby:tables", tables);
  });
}
