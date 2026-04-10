import type { Express } from "express";
import {
  fetchParsedPage,
  fetchRandomMainArticleTitle,
  fetchTargetPageClues,
  tryNavigate,
} from "./wikipedia.js";

function readExcludeTitles(query: unknown): string[] {
  if (query == null) return [];
  if (Array.isArray(query)) {
    return query.map(String).filter(Boolean);
  }
  return [String(query)].filter(Boolean);
}

export function attachApiRoutes(app: Express): void {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/random-title", async (req, res) => {
    try {
      const exclude = readExcludeTitles(req.query.exclude);
      const title = await fetchRandomMainArticleTitle(exclude);
      res.json({ title });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/target-clues/:title", async (req, res) => {
    try {
      const raw = decodeURIComponent(req.params.title);
      const result = await fetchTargetPageClues(raw);
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/page/:title", async (req, res) => {
    try {
      const title = decodeURIComponent(req.params.title);
      const page = await fetchParsedPage(title);
      res.json(page);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/step", async (req, res) => {
    try {
      const from = String(req.body?.from ?? "");
      const to = String(req.body?.to ?? "");
      if (!from || !to) {
        res.status(400).json({ error: "Paramètres from et to requis" });
        return;
      }
      const page = await tryNavigate(from, to);
      res.json(page);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      res.status(400).json({ error: msg });
    }
  });
}
