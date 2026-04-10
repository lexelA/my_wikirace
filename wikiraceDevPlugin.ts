import cors from "cors";
import express from "express";
import type { Plugin, ViteDevServer } from "vite";
import { Server } from "socket.io";
import { attachApiRoutes } from "./server/apiRoutes.js";
import { attachSocketIO } from "./server/socketHandlers.js";

/**
 * En dev, monte l'API Express et Socket.io sur le même HTTP server que Vite,
 * pour qu'un seul `vite` suffise (plus de proxy vers :3001).
 */
export function wikiraceDevPlugin(): Plugin {
  return {
    name: "wikirace-dev-api",
    configureServer(server: ViteDevServer) {
      const api = express();
      api.use(cors({ origin: true }));
      api.use(express.json());
      attachApiRoutes(api);

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url.startsWith("/api")) {
          api(req, res, next);
        } else {
          next();
        }
      });

      const httpServer = server.httpServer;
      if (!httpServer) {
        console.warn("[wikirace] httpServer indisponible : Socket.io non attaché");
        return;
      }

      const io = new Server(httpServer, { cors: { origin: true } });
      attachSocketIO(io);
    },
  };
}
