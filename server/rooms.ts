import { randomBytes } from "node:crypto";
import type { ParsedPage } from "./wikipedia.js";
import { fetchParsedPage, tryNavigate } from "./wikipedia.js";

export type RoomStatus = "lobby" | "playing" | "finished";

export type PlayerState = {
  id: string;
  socketId: string;
  name: string;
  path: string[];
  isHost: boolean;
};

export type WinnerInfo = {
  name: string;
  ms: number;
  path: string[];
};

export type Room = {
  code: string;
  hostSocketId: string;
  players: Map<string, PlayerState>;
  startTitle: string | null;
  endTitle: string | null;
  status: RoomStatus;
  gameStartedAt: number | null;
  winner: WinnerInfo | null;
};

const rooms = new Map<string, Room>();

function genCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export function createRoom(hostSocketId: string, playerName: string): Room {
  let code = genCode();
  while (rooms.has(code)) code = genCode();
  const player: PlayerState = {
    id: randomBytes(8).toString("hex"),
    socketId: hostSocketId,
    name: playerName.trim() || "Joueur",
    path: [],
    isHost: true,
  };
  const room: Room = {
    code,
    hostSocketId,
    players: new Map([[hostSocketId, player]]),
    startTitle: null,
    endTitle: null,
    status: "lobby",
    gameStartedAt: null,
    winner: null,
  };
  rooms.set(code, room);
  return room;
}

export function joinRoom(
  code: string,
  socketId: string,
  playerName: string
): { ok: true; room: Room } | { ok: false; reason: string } {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { ok: false, reason: "Code inconnu" };
  if (room.status !== "lobby") return { ok: false, reason: "Partie déjà commencée" };
  if (room.players.has(socketId)) return { ok: false, reason: "Déjà dans la salle" };
  const player: PlayerState = {
    id: randomBytes(8).toString("hex"),
    socketId,
    name: playerName.trim() || "Joueur",
    path: [],
    isHost: false,
  };
  room.players.set(socketId, player);
  return { ok: true, room };
}

export function leaveRoom(socketId: string): string | null {
  for (const [code, room] of rooms) {
    if (!room.players.has(socketId)) continue;
    room.players.delete(socketId);
    if (room.hostSocketId === socketId && room.players.size > 0) {
      const next = room.players.values().next().value as PlayerState;
      room.hostSocketId = next.socketId;
      next.isHost = true;
    }
    if (room.players.size === 0) rooms.delete(code);
    return code;
  }
  return null;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function setPages(
  room: Room,
  socketId: string,
  startTitle: string,
  endTitle: string
): { ok: true } | { ok: false; reason: string } {
  if (room.hostSocketId !== socketId) return { ok: false, reason: "Réservé à l'hôte" };
  if (room.status !== "lobby") return { ok: false, reason: "Partie en cours" };
  const s = startTitle.trim();
  const e = endTitle.trim();
  if (!s || !e) return { ok: false, reason: "Début et fin requis" };
  room.startTitle = s;
  room.endTitle = e;
  return { ok: true };
}

export async function startGame(
  room: Room,
  socketId: string
): Promise<
  | { ok: true; startPage: ParsedPage; gameStartedAt: number }
  | { ok: false; reason: string }
> {
  if (room.hostSocketId !== socketId) return { ok: false, reason: "Réservé à l'hôte" };
  if (!room.startTitle || !room.endTitle)
    return { ok: false, reason: "Définissez début et fin" };
  let startPage: ParsedPage;
  try {
    startPage = await fetchParsedPage(room.startTitle);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Erreur page de départ",
    };
  }
  try {
    const endPage = await fetchParsedPage(room.endTitle);
    room.endTitle = endPage.title;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Erreur page d'arrivée",
    };
  }
  room.startTitle = startPage.title;
  const started = Date.now();
  room.gameStartedAt = started;
  room.status = "playing";
  room.winner = null;
  for (const p of room.players.values()) {
    p.path = [startPage.title];
  }
  return { ok: true, startPage, gameStartedAt: started };
}

export async function navigatePlayer(
  room: Room,
  socketId: string,
  targetTitle: string
): Promise<
  | {
      ok: true;
      page: ParsedPage;
      path: string[];
      won: boolean;
      ms?: number;
    }
  | { ok: false; reason: string }
> {
  if (room.status !== "playing" || !room.gameStartedAt || !room.endTitle) {
    return { ok: false, reason: "Pas de partie en cours" };
  }
  const player = room.players.get(socketId);
  if (!player) return { ok: false, reason: "Joueur inconnu" };
  if (room.winner) return { ok: false, reason: "Partie terminée" };

  const current = player.path[player.path.length - 1];
  if (!current) return { ok: false, reason: "État invalide" };

  let nextPage: ParsedPage;
  try {
    nextPage = await tryNavigate(current, targetTitle);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Navigation impossible",
    };
  }

  player.path.push(nextPage.title);
  const won =
    nextPage.title.trim().toLowerCase() === room.endTitle.trim().toLowerCase();
  let ms: number | undefined;
  if (won) {
    ms = Date.now() - room.gameStartedAt;
    room.status = "finished";
    room.winner = { name: player.name, ms, path: [...player.path] };
  }

  return {
    ok: true,
    page: nextPage,
    path: [...player.path],
    won,
    ms,
  };
}
