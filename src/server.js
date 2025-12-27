import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createScheduler } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function bootstrap() {
  const app = express();
  const scheduler = await createScheduler();

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/cards/next", (_req, res, next) => {
    try {
      res.json(scheduler.getNextCard());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:id/rate", async (req, res, next) => {
    try {
      const cardId = Number(req.params.id);
      const rating = req.body?.rating;

      if (!Number.isFinite(cardId)) {
        const error = new Error("Card id must be numeric");
        error.statusCode = 400;
        throw error;
      }

      if (typeof rating !== "string") {
        const error = new Error("Rating is required");
        error.statusCode = 400;
        throw error;
      }

      const payload = await scheduler.rateCard(cardId, rating.toLowerCase());
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => {
    const isApiRequest = req.path.startsWith("/api");
    if (!isApiRequest && req.method === "GET" && req.accepts("html")) {
      res.sendFile(path.join(PUBLIC_DIR, "index.html"));
      return;
    }
    next();
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    const status = error.statusCode ?? 500;
    res.status(status).json({ error: error.message ?? "Unexpected server error" });
  });

  app.listen(PORT, () => {
    console.log(`Flashcards server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
