import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { titleFromWikiHref } from "./wiki";

type PagePayload = { title: string; html: string };

type Phase = "setup" | "lobby" | "playing" | "won";

type RoomSummary = {
  code: string;
  status: string;
  startTitle: string | null;
  endTitle: string | null;
  players: { id: string; name: string; isHost: boolean; pathLength: number }[];
};

/** Affichage chrono : minutes et secondes entières uniquement. */
function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min} min ${sec} s`;
  return `${sec} s`;
}

/** Premier indice sur la page cible, puis un nouvel indice à cet intervalle. */
const CLUE_FIRST_DELAY_MS = 10_000;
const CLUE_INTERVAL_MS = 13_000;

/** Raccourcis « rechercher dans la page » (anti-triche, best-effort selon le navigateur). */
function isPageFindShortcut(e: KeyboardEvent): boolean {
  if (e.key === "F3") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return false;
  const k = e.key.toLowerCase();
  return k === "f" || k === "g";
}

/** Lorsque la réponse n'est pas OK : JSON `{ error }` ou message explicite (proxy, serveur absent). */
async function readApiError(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { error?: string };
    if (typeof j.error === "string" && j.error.trim()) return j.error;
  } catch {
    /* pas du JSON */
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return "Le serveur n'est pas joignable. Lance le backend (ex. `npm run dev:server`) ou `npm run dev` dans un autre terminal.";
  }
  if (res.status === 404) {
    return "Route API introuvable (404). Vérifie que le proxy Vite pointe vers le backend (port 3001).";
  }
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  if (snippet) return `Erreur HTTP ${res.status}: ${snippet}`;
  return `Erreur HTTP ${res.status}: vérifie que le serveur est lancé sur le port 3001.`;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<"solo" | "multi">("solo");
  const [playerName, setPlayerName] = useState("");
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [roomSummary, setRoomSummary] = useState<RoomSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState<PagePayload | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [endTitle, setEndTitle] = useState<string | null>(null);
  const [gameStartedAt, setGameStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [winnerName, setWinnerName] = useState<string | null>(null);
  const [winnerMs, setWinnerMs] = useState<number | null>(null);
  const [winnerPath, setWinnerPath] = useState<string[] | null>(null);
  const [randomBusy, setRandomBusy] = useState<null | "start" | "end">(null);
  /** null = chargement ou pas de partie ; [] = aucun indice extrait */
  const [targetClues, setTargetClues] = useState<string[] | null>(null);
  const [clueRevealCount, setClueRevealCount] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const articleRef = useRef<HTMLDivElement | null>(null);
  const lobbyCtxRef = useRef({ phase, isHost, roomCode: null as string | null });
  lobbyCtxRef.current = { phase, isHost, roomCode };

  useEffect(() => {
    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("roomUpdate", (room: RoomSummary) => {
      setRoomSummary(room);
    });

    socket.on(
      "gameStarted",
      (payload: {
        startPage: PagePayload;
        gameStartedAt: number;
        endTitle: string;
        room: RoomSummary;
      }) => {
        setRoomSummary(payload.room);
        setCurrentPage(payload.startPage);
        setPath([payload.startPage.title]);
        setEndTitle(payload.endTitle);
        setGameStartedAt(payload.gameStartedAt);
        setTargetClues(null);
        setClueRevealCount(0);
        setPhase("playing");
        setError(null);
      }
    );

    socket.on(
      "gameOver",
      (data: { winnerName: string; ms: number; path: string[] }) => {
        setWinnerName(data.winnerName);
        setWinnerMs(data.ms);
        setWinnerPath(data.path);
        setPhase("won");
      }
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== "playing" || gameStartedAt == null) return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - gameStartedAt);
    }, 1000);
    return () => clearInterval(id);
  }, [phase, gameStartedAt]);

  useEffect(() => {
    if (phase !== "playing" || !endTitle) {
      setTargetClues(null);
      setClueRevealCount(0);
      return;
    }
    setTargetClues(null);
    setClueRevealCount(0);
    let cancelled = false;
    void fetch(`/api/target-clues/${encodeURIComponent(endTitle)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { clues?: string[] } | null) => {
        if (!cancelled) setTargetClues(Array.isArray(data?.clues) ? data.clues : []);
      })
      .catch(() => {
        if (!cancelled) setTargetClues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, endTitle]);

  useEffect(() => {
    if (phase !== "playing" || gameStartedAt == null || targetClues === null) return;
    const n = targetClues.length;
    if (n === 0) return;
    setClueRevealCount(0);
    const elapsed = Date.now() - gameStartedAt;
    const timers: number[] = [];
    for (let i = 0; i < n; i++) {
      const targetT = CLUE_FIRST_DELAY_MS + i * CLUE_INTERVAL_MS;
      const wait = Math.max(0, targetT - elapsed);
      timers.push(
        window.setTimeout(() => {
          setClueRevealCount((prev) => Math.max(prev, i + 1));
        }, wait)
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [phase, gameStartedAt, targetClues]);

  useEffect(() => {
    if (phase !== "playing") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPageFindShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase]);

  const resetToSetup = useCallback(() => {
    setPhase("setup");
    setRoomCode(null);
    setIsHost(false);
    setRoomSummary(null);
    setCurrentPage(null);
    setPath([]);
    setEndTitle(null);
    setGameStartedAt(null);
    setElapsedMs(0);
    setWinnerName(null);
    setWinnerMs(null);
    setWinnerPath(null);
    setError(null);
    setRandomBusy(null);
    setTargetClues(null);
    setClueRevealCount(0);
  }, []);

  const fillRandom = async (which: "start" | "end") => {
    const startBefore = startInput.trim();
    const endBefore = endInput.trim();
    setRandomBusy(which);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (which === "start" && endBefore) params.append("exclude", endBefore);
      if (which === "end" && startBefore) params.append("exclude", startBefore);
      const url = params.toString() ? `/api/random-title?${params}` : "/api/random-title";
      const res = await fetch(url);
      if (!res.ok) {
        const msg = await readApiError(res);
        throw new Error(msg);
      }
      const data = (await res.json()) as { title?: string };
      if (!data.title) throw new Error("Réponse invalide");
      const nextStart = which === "start" ? data.title : startBefore;
      const nextEnd = which === "end" ? data.title : endBefore;
      if (which === "start") setStartInput(data.title);
      else setEndInput(data.title);

      const { phase: ph, isHost: host, roomCode: rc } = lobbyCtxRef.current;
      const s = socketRef.current;
      if (ph === "lobby" && host && rc && nextStart && nextEnd && s) {
        s.emit(
          "setPages",
          { roomCode: rc, startTitle: nextStart, endTitle: nextEnd },
          (r: { ok: boolean; room?: RoomSummary; reason?: string }) => {
            if (r.ok && r.room) setRoomSummary(r.room);
            else if (!r.ok && r.reason) setError(r.reason);
          }
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setRandomBusy(null);
    }
  };

  const createRoom = () => {
    const s = socketRef.current;
    if (!s) return;
    setError(null);
    s.emit("createRoom", { playerName: playerName || "Joueur" }, (res: { ok: boolean; roomCode?: string; room?: RoomSummary; reason?: string }) => {
      if (!res.ok || !res.roomCode || !res.room) {
        setError(res.reason ?? "Impossible de créer la salle");
        return;
      }
      setRoomCode(res.roomCode);
      setIsHost(true);
      setRoomSummary(res.room);
      setPhase("lobby");
      if (startInput.trim() && endInput.trim()) {
        s.emit(
          "setPages",
          { roomCode: res.roomCode, startTitle: startInput, endTitle: endInput },
          (r: { ok: boolean; room?: RoomSummary; reason?: string }) => {
            if (r.ok && r.room) setRoomSummary(r.room);
            else if (!r.ok && r.reason) setError(r.reason);
          }
        );
      }
    });
  };

  const joinRoom = () => {
    const s = socketRef.current;
    if (!s) return;
    setError(null);
    s.emit(
      "joinRoom",
      { roomCode: roomCodeInput, playerName: playerName || "Joueur" },
      (res: { ok: boolean; roomCode?: string; room?: RoomSummary; reason?: string }) => {
        if (!res.ok || !res.roomCode || !res.room) {
          setError(res.reason ?? "Impossible de rejoindre");
          return;
        }
        setRoomCode(res.roomCode);
        setIsHost(false);
        setRoomSummary(res.room);
        setPhase("lobby");
      }
    );
  };

  const applyPages = () => {
    const s = socketRef.current;
    if (!s || !roomCode) return;
    setError(null);
    s.emit(
      "setPages",
      { roomCode, startTitle: startInput, endTitle: endInput },
      (res: { ok: boolean; room?: RoomSummary; reason?: string }) => {
        if (!res.ok) {
          setError(res.reason ?? "Erreur");
          return;
        }
        if (res.room) setRoomSummary(res.room);
      }
    );
  };

  const startMultiGame = () => {
    const s = socketRef.current;
    if (!s || !roomCode) return;
    setError(null);
    const st = startInput.trim();
    const en = endInput.trim();
    if (!st || !en) {
      setError("Renseigne la page de début et la page d'arrivée.");
      return;
    }
    s.emit(
      "setPages",
      { roomCode, startTitle: st, endTitle: en },
      (r: { ok: boolean; room?: RoomSummary; reason?: string }) => {
        if (!r.ok) {
          setError(r.reason ?? "Impossible d'enregistrer début / fin");
          return;
        }
        if (r.room) setRoomSummary(r.room);
        s.emit("startGame", { roomCode }, (res: { ok: boolean; reason?: string }) => {
          if (!res.ok) setError(res.reason ?? "Démarrage impossible");
        });
      }
    );
  };

  const startSoloGame = async () => {
    setError(null);
    if (!startInput.trim() || !endInput.trim()) {
      setError("Indique un titre de départ et un titre d'arrivée.");
      return;
    }
    try {
      const [startRes, endRes] = await Promise.all([
        fetch(`/api/page/${encodeURIComponent(startInput)}`),
        fetch(`/api/page/${encodeURIComponent(endInput)}`),
      ]);
      if (!startRes.ok) {
        const msg = await readApiError(startRes);
        throw new Error(`Page de départ : ${msg}`);
      }
      if (!endRes.ok) {
        const msg = await readApiError(endRes);
        throw new Error(`Page d'arrivée : ${msg}`);
      }
      const startPage = (await startRes.json()) as PagePayload;
      const endPage = (await endRes.json()) as PagePayload;
      const t0 = Date.now();
      setEndTitle(endPage.title);
      setCurrentPage(startPage);
      setPath([startPage.title]);
      setGameStartedAt(t0);
      setPhase("playing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  };

  const handleArticleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (phase !== "playing" || !currentPage) return;
      const el = (e.target as HTMLElement).closest("a");
      if (!el) return;
      const href = el.getAttribute("href");
      if (!href) return;
      const targetTitle = titleFromWikiHref(href);
      if (!targetTitle) return;
      e.preventDefault();

      if (mode === "solo") {
        void (async () => {
          try {
            const res = await fetch("/api/step", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ from: currentPage.title, to: targetTitle }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              setError((j as { error?: string }).error ?? "Coup invalide");
              return;
            }
            const next = (await res.json()) as PagePayload;
            setError(null);
            setCurrentPage(next);
            setPath((prev) => {
              const np = [...prev, next.title];
              if (
                endTitle &&
                next.title.trim().toLowerCase() === endTitle.trim().toLowerCase()
              ) {
                const ms = gameStartedAt ? Date.now() - gameStartedAt : 0;
                setWinnerName(playerName || "Joueur");
                setWinnerMs(ms);
                setWinnerPath(np);
                setPhase("won");
              }
              return np;
            });
          } catch {
            setError("Erreur réseau");
          }
        })();
        return;
      }

      const s = socketRef.current;
      const rc = roomCode;
      if (!s || !rc) return;
      s.emit(
        "navigate",
        { roomCode: rc, targetTitle },
        (res: {
          ok: boolean;
          page?: PagePayload;
          path?: string[];
          won?: boolean;
          ms?: number;
          reason?: string;
        }) => {
          if (!res.ok || !res.page || !res.path) {
            setError(res.reason ?? "Navigation refusée");
            return;
          }
          setError(null);
          setCurrentPage(res.page);
          setPath(res.path);
        }
      );
    },
    [phase, currentPage, mode, endTitle, gameStartedAt, roomCode]
  );

  const pathForWin = winnerPath ?? path;

  let nextClueInMs = 0;
  if (
    phase === "playing" &&
    gameStartedAt != null &&
    targetClues &&
    targetClues.length > 0 &&
    clueRevealCount < targetClues.length
  ) {
    const nextAt = CLUE_FIRST_DELAY_MS + clueRevealCount * CLUE_INTERVAL_MS;
    nextClueInMs = Math.max(0, nextAt - elapsedMs);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid #30363d",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "1.15rem" }}>Wikirace</strong>
        {phase === "playing" && gameStartedAt != null && (
          <div style={{ fontVariantNumeric: "tabular-nums", fontSize: "1.25rem" }}>
            ⏱ {formatMs(elapsedMs)}
          </div>
        )}
        {phase === "playing" && endTitle && (
          <span
            style={{
              opacity: 0.92,
              maxWidth: "min(420px, 100%)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={endTitle}
          >
            Objectif : <em>{endTitle}</em>
          </span>
        )}
      </header>

      {phase === "playing" && endTitle && (
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid #30363d",
            background: "#161b22",
            fontSize: "0.92rem",
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, opacity: 0.95 }}>
            Indices sur la page cible (infobox, dates dans l’intro…)
          </div>
          {targetClues === null && (
            <span style={{ opacity: 0.8 }}>Chargement des indices…</span>
          )}
          {targetClues !== null && targetClues.length === 0 && (
            <span style={{ opacity: 0.8 }}>
              Aucun indice automatique pour cette page (souvent le cas sans infobox utile).
            </span>
          )}
          {targetClues !== null && targetClues.length > 0 && (
            <>
              {clueRevealCount === 0 && (
                <p style={{ margin: "0 0 8px", opacity: 0.82, fontSize: "0.88rem" }}>
                  Le titre à atteindre est affiché ci-dessus. Les indices détaillés apparaissent
                  petit à petit.
                </p>
              )}
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {targetClues.slice(0, clueRevealCount).map((c, i) => (
                  <li key={`${i}-${c.slice(0, 24)}`} style={{ marginBottom: 6 }}>
                    {c}
                  </li>
                ))}
              </ul>
              {clueRevealCount < targetClues.length && nextClueInMs > 0 && (
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: "0.85rem",
                    opacity: 0.75,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  Prochain indice dans environ {formatMs(nextClueInMs)}.
                </p>
              )}
              {clueRevealCount >= targetClues.length && clueRevealCount > 0 && (
                <p style={{ margin: "8px 0 0", fontSize: "0.82rem", opacity: 0.7 }}>
                  Tous les indices disponibles ont été affichés.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            background: "#3d1f1f",
            color: "#f8d7da",
            padding: "10px 20px",
            borderBottom: "1px solid #842029",
          }}
        >
          {error}
        </div>
      )}

      <main
        style={{
          flex: 1,
          padding: "20px",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {phase === "setup" && (
          <div style={{ maxWidth: 480, margin: "0 auto" }}>
            <h1 style={{ marginTop: 0 }}>Configuration</h1>
            <label style={{ display: "block", marginBottom: 12 }}>
              Votre pseudo
              <input
                style={{ display: "block", width: "100%", marginTop: 6, padding: 10 }}
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="ex. Alex"
              />
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <button
                type="button"
                onClick={() => setMode("solo")}
                style={{
                  flex: 1,
                  padding: 12,
                  borderRadius: 8,
                  border: mode === "solo" ? "2px solid #8ab4f8" : "1px solid #444",
                  background: mode === "solo" ? "#1a2332" : "#1c2128",
                }}
              >
                Solo
              </button>
              <button
                type="button"
                onClick={() => setMode("multi")}
                style={{
                  flex: 1,
                  padding: 12,
                  borderRadius: 8,
                  border: mode === "multi" ? "2px solid #8ab4f8" : "1px solid #444",
                  background: mode === "multi" ? "#1a2332" : "#1c2128",
                }}
              >
                Multijoueur
              </button>
            </div>

            <label style={{ display: "block", marginBottom: 12 }}>
              Page de début (titre Wikipedia)
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  style={{ flex: 1, minWidth: 0, padding: 10 }}
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  placeholder="ex. Paris"
                />
                <button
                  type="button"
                  disabled={randomBusy !== null}
                  onClick={() => void fillRandom("start")}
                  style={{
                    flexShrink: 0,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#21262d",
                    color: "#e8eaed",
                    fontSize: "0.85rem",
                    whiteSpace: "nowrap",
                    opacity: randomBusy === "start" ? 0.6 : 1,
                  }}
                >
                  {randomBusy === "start" ? "…" : "Au hasard"}
                </button>
              </div>
            </label>
            <label style={{ display: "block", marginBottom: 20 }}>
              Page d'arrivée
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  style={{ flex: 1, minWidth: 0, padding: 10 }}
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  placeholder="ex. Fromage"
                />
                <button
                  type="button"
                  disabled={randomBusy !== null}
                  onClick={() => void fillRandom("end")}
                  style={{
                    flexShrink: 0,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#21262d",
                    color: "#e8eaed",
                    fontSize: "0.85rem",
                    whiteSpace: "nowrap",
                    opacity: randomBusy === "end" ? 0.6 : 1,
                  }}
                >
                  {randomBusy === "end" ? "…" : "Au hasard"}
                </button>
              </div>
            </label>

            {mode === "solo" ? (
              <button
                type="button"
                onClick={startSoloGame}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 8,
                  border: "none",
                  background: "#1a73e8",
                  color: "#fff",
                  fontWeight: 600,
                }}
              >
                START
              </button>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={createRoom}
                    style={{
                      flex: 1,
                      padding: 12,
                      borderRadius: 8,
                      border: "1px solid #444",
                      background: "#21262d",
                      color: "#e8eaed",
                    }}
                  >
                    Créer une salle
                  </button>
                </div>
                <label style={{ display: "block", marginBottom: 8 }}>
                  Rejoindre avec un code
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <input
                      style={{ flex: 1, padding: 10 }}
                      value={roomCodeInput}
                      onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                      placeholder="CODE"
                    />
                    <button
                      type="button"
                      onClick={joinRoom}
                      style={{
                        padding: "10px 16px",
                        borderRadius: 8,
                        border: "1px solid #444",
                        background: "#21262d",
                        color: "#e8eaed",
                      }}
                    >
                      Rejoindre
                    </button>
                  </div>
                </label>
              </>
            )}
          </div>
        )}

        {phase === "lobby" && roomSummary && (
          <div style={{ maxWidth: 520, margin: "0 auto" }}>
            <h1 style={{ marginTop: 0 }}>Lobby</h1>
            <p>
              Code : <strong style={{ letterSpacing: "0.1em" }}>{roomSummary.code}</strong>
            </p>
            <p style={{ opacity: 0.85 }}>
              Début : {roomSummary.startTitle ?? "—"} · Fin : {roomSummary.endTitle ?? "—"}
            </p>
            <h3>Joueurs</h3>
            <ul>
              {roomSummary.players.map((p) => (
                <li key={p.id}>
                  {p.name}
                  {p.isHost ? " (hôte)" : ""}
                </li>
              ))}
            </ul>
            {isHost && (
              <>
                <label style={{ display: "block", marginBottom: 8 }}>
                  Début
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <input
                      style={{ flex: 1, minWidth: 0, padding: 8 }}
                      value={startInput}
                      onChange={(e) => setStartInput(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={randomBusy !== null}
                      onClick={() => void fillRandom("start")}
                      style={{
                        flexShrink: 0,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #444",
                        background: "#21262d",
                        color: "#e8eaed",
                        fontSize: "0.85rem",
                        whiteSpace: "nowrap",
                        opacity: randomBusy === "start" ? 0.6 : 1,
                      }}
                    >
                      {randomBusy === "start" ? "…" : "Au hasard"}
                    </button>
                  </div>
                </label>
                <label style={{ display: "block", marginBottom: 8 }}>
                  Fin
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <input
                      style={{ flex: 1, minWidth: 0, padding: 8 }}
                      value={endInput}
                      onChange={(e) => setEndInput(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={randomBusy !== null}
                      onClick={() => void fillRandom("end")}
                      style={{
                        flexShrink: 0,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #444",
                        background: "#21262d",
                        color: "#e8eaed",
                        fontSize: "0.85rem",
                        whiteSpace: "nowrap",
                        opacity: randomBusy === "end" ? 0.6 : 1,
                      }}
                    >
                      {randomBusy === "end" ? "…" : "Au hasard"}
                    </button>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={applyPages}
                  style={{
                    marginRight: 8,
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#21262d",
                    color: "#e8eaed",
                  }}
                >
                  Enregistrer début / fin
                </button>
                <button
                  type="button"
                  onClick={startMultiGame}
                  style={{
                    padding: "10px 20px",
                    borderRadius: 8,
                    border: "none",
                    background: "#1a73e8",
                    color: "#fff",
                    fontWeight: 600,
                  }}
                >
                  START
                </button>
                <p style={{ marginTop: 12, opacity: 0.75, fontSize: "0.85rem" }}>
                  START enregistre début / fin sur le serveur puis lance la partie (tu peux aussi
                  utiliser « Enregistrer » seul pour que les autres voient les titres avant).
                </p>
              </>
            )}
            {!isHost && (
              <p style={{ opacity: 0.8 }}>En attente de l'hôte…</p>
            )}
          </div>
        )}

        {phase === "playing" && currentPage && (
          <div
            ref={articleRef}
            className="wiki-body wiki-article-scroll"
            onClick={handleArticleClick}
            style={{
              flex: 1,
              minHeight: 0,
              maxWidth: 900,
              width: "100%",
              margin: "0 auto",
              padding: "8px 0 24px",
              lineHeight: 1.6,
              overflowY: "auto",
              overflowX: "hidden",
            }}
            dangerouslySetInnerHTML={{ __html: currentPage.html }}
          />
        )}

        {phase === "won" && (
          <div
            style={{
              maxWidth: 520,
              margin: "40px auto",
              padding: 24,
              borderRadius: 12,
              border: "1px solid #30363d",
              background: "#161b22",
            }}
          >
            <h1 style={{ marginTop: 0, color: "#7ee787" }}>
              {winnerName} a gagné !
            </h1>
            {winnerMs != null && (
              <p style={{ fontSize: "1.2rem" }}>Temps : {formatMs(winnerMs)}</p>
            )}
            <p>
              Pages traversées : <strong>{pathForWin.length}</strong>
            </p>
            <ol style={{ paddingLeft: 20 }}>
              {pathForWin.map((t, i) => (
                <li key={`${i}-${t}`}>{t}</li>
              ))}
            </ol>
            <button
              type="button"
              onClick={resetToSetup}
              style={{
                marginTop: 16,
                padding: "12px 20px",
                borderRadius: 8,
                border: "none",
                background: "#1a73e8",
                color: "#fff",
                fontWeight: 600,
              }}
            >
              Retour au menu
            </button>
          </div>
        )}
      </main>

      <footer
        style={{
          padding: "10px 20px",
          borderTop: "1px solid #30363d",
          fontSize: 12,
          opacity: 0.65,
        }}
      >
        Contenu affiché via l&apos;API Wikipédia (fr.wikipedia.org). Jeu éducatif local.
      </footer>
    </div>
  );
}
