import express from "express";
import cors from "cors";
import http from "node:http";
import { Server } from "socket.io";
import { attachApiRoutes } from "./apiRoutes.js";
import { attachSocketIO } from "./socketHandlers.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
attachApiRoutes(app);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
});
attachSocketIO(io);

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Wikirace server http://127.0.0.1:${PORT}`);
});
