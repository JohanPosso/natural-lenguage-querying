import express, { Request, Response } from "express";
import path from "path";
import { env } from "./config/env";
import { authMiddleware } from "./middlewares/authMiddleware";
import { askController } from "./controllers/askController";
import {
  askInConversationController,
  createConversationController,
  listConversationsController,
  listMessagesController
} from "./controllers/chatController";
import { getDebugLogsController, getDebugSummaryController } from "./controllers/debugController";

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

// ── CORS (para front en otro dominio/puerto) ──────────────────────────────
// El front envía Authorization y eso dispara preflight OPTIONS.
// Permitimos Authorization + Content-Type y respondemos a OPTIONS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = env.corsAllowedOrigins.trim();
    const allowAny = allowed === "*" || allowed.length === 0;

    const list = allowAny
      ? []
      : allowed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    if (allowAny || list.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }
  // Si no hay origin (ej. curl), omitimos la cabecera CORS.
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Rutas públicas (sin autenticación)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/chat", (_req: Request, res: Response) => {
  res.sendFile(path.resolve(process.cwd(), "public", "chat.html"));
});

// Rutas protegidas — requieren token válido del API Launcher
app.post("/ask", authMiddleware, askController);

app.get("/api/chat/conversations", authMiddleware, listConversationsController);
app.post("/api/chat/conversations", authMiddleware, createConversationController);
app.get("/api/chat/conversations/:id/messages", authMiddleware, listMessagesController);
app.post("/api/chat/ask", authMiddleware, askInConversationController);

// Debug — solo accesible internamente (sin auth para facilitar monitoreo)
app.get("/api/debug/logs", getDebugLogsController);
app.get("/api/debug/summary", getDebugSummaryController);

app.listen(env.port, () => {
  console.log(`API listening on port ${env.port}`);
  console.log(`Chat UI available at http://localhost:${env.port}/chat`);
  console.log(`Log viewer  available at http://localhost:${env.port}/logs.html`);
  if (env.bypassAuth) {
    console.warn("[auth] ⚠ BYPASS_AUTH=true — autenticación DESACTIVADA (solo desarrollo)");
  } else {
    console.log(`[auth] Autenticación activa via API Launcher: ${env.apiLauncherEndpoint}`);
    console.log(`[auth] Producto ID: ${env.productId}`);
  }
});
