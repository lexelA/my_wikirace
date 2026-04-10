import type { Server } from "socket.io";
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  setPages,
  startGame,
  navigatePlayer,
} from "./rooms.js";
import type { Room } from "./rooms.js";

function serializeRoom(room: Room) {
  return {
    code: room.code,
    status: room.status,
    startTitle: room.startTitle,
    endTitle: room.endTitle,
    gameStartedAt: room.gameStartedAt,
    winner: room.winner,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      pathLength: p.path.length,
    })),
  };
}

export function attachSocketIO(io: Server): void {
  io.on("connection", (socket) => {
    socket.on(
      "createRoom",
      (payload: { playerName: string }, cb: (r: unknown) => void) => {
        const name =
          typeof payload?.playerName === "string" ? payload.playerName : "Joueur";
        const room = createRoom(socket.id, name);
        socket.join(room.code);
        cb({
          ok: true,
          roomCode: room.code,
          playerId: [...room.players.values()].find((p) => p.socketId === socket.id)
            ?.id,
          room: serializeRoom(room),
        });
      }
    );

    socket.on(
      "joinRoom",
      (
        payload: { roomCode: string; playerName: string },
        cb: (r: unknown) => void
      ) => {
        const code = typeof payload?.roomCode === "string" ? payload.roomCode : "";
        const name =
          typeof payload?.playerName === "string" ? payload.playerName : "Joueur";
        const result = joinRoom(code, socket.id, name);
        if (!result.ok) {
          cb({ ok: false, reason: result.reason });
          return;
        }
        socket.join(result.room.code);
        io.to(result.room.code).emit("roomUpdate", serializeRoom(result.room));
        cb({
          ok: true,
          roomCode: result.room.code,
          playerId: result.room.players.get(socket.id)?.id,
          room: serializeRoom(result.room),
        });
      }
    );

    socket.on(
      "setPages",
      (
        payload: { roomCode: string; startTitle: string; endTitle: string },
        cb: (r: unknown) => void
      ) => {
        const room = getRoom(payload?.roomCode ?? "");
        if (!room) {
          cb({ ok: false, reason: "Salle introuvable" });
          return;
        }
        const result = setPages(
          room,
          socket.id,
          String(payload?.startTitle ?? ""),
          String(payload?.endTitle ?? "")
        );
        if (!result.ok) {
          cb({ ok: false, reason: result.reason });
          return;
        }
        io.to(room.code).emit("roomUpdate", serializeRoom(room));
        cb({ ok: true, room: serializeRoom(room) });
      }
    );

    socket.on(
      "startGame",
      async (payload: { roomCode: string }, cb: (r: unknown) => void) => {
        const room = getRoom(payload?.roomCode ?? "");
        if (!room) {
          cb({ ok: false, reason: "Salle introuvable" });
          return;
        }
        const result = await startGame(room, socket.id);
        if (!result.ok) {
          cb({ ok: false, reason: result.reason });
          return;
        }
        io.to(room.code).emit("gameStarted", {
          startPage: { title: result.startPage.title, html: result.startPage.html },
          gameStartedAt: result.gameStartedAt,
          endTitle: room.endTitle,
          room: serializeRoom(room),
        });
        cb({ ok: true });
      }
    );

    socket.on(
      "navigate",
      async (
        payload: { roomCode: string; targetTitle: string },
        cb: (r: unknown) => void
      ) => {
        const room = getRoom(payload?.roomCode ?? "");
        if (!room) {
          cb({ ok: false, reason: "Salle introuvable" });
          return;
        }
        const targetTitle = String(payload?.targetTitle ?? "");
        const result = await navigatePlayer(room, socket.id, targetTitle);
        if (!result.ok) {
          cb({ ok: false, reason: result.reason });
          return;
        }
        const playerName = room.players.get(socket.id)?.name;
        io.to(room.code).emit("playerProgress", {
          socketId: socket.id,
          playerName,
          pathLength: result.path.length,
          currentTitle: result.page.title,
        });
        if (result.won && result.ms !== undefined && playerName) {
          io.to(room.code).emit("gameOver", {
            winnerName: playerName,
            ms: result.ms,
            path: result.path,
          });
        }
        cb({
          ok: true,
          page: { title: result.page.title, html: result.page.html },
          path: result.path,
          won: result.won,
          ms: result.ms,
        });
      }
    );

    socket.on("disconnect", () => {
      const code = leaveRoom(socket.id);
      if (code) {
        const room = getRoom(code);
        if (room) io.to(code).emit("roomUpdate", serializeRoom(room));
      }
    });
  });
}
