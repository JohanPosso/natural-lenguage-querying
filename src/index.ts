import express, { Request, Response } from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { env } from "./config/env";
import { authMiddleware } from "./middlewares/authMiddleware";
import { requireSuperAdmin } from "./middlewares/requireSuperAdmin";
import { askController } from "./controllers/askController";
import {
  askInConversationController,
  createConversationController,
  deleteConversationController,
  listConversationsController,
  listMessagesController
} from "./controllers/chatController";
import { getDebugLogsController, getDebugSummaryController } from "./controllers/debugController";
import {
  createGlobalRuleController,
  deleteGlobalRuleController,
  listGlobalRulesController,
  updateGlobalRuleController
} from "./controllers/globalRulesController";
import { authMeController } from "./controllers/authMeController";
import {
  createCustomerRuleController,
  deleteCustomerRuleController,
  listCustomerRulesController,
  updateCustomerRuleController
} from "./controllers/customerRulesController";
import {
  getAdminCustomerController,
  listAdminCustomersController
} from "./controllers/adminCustomersController";
import { memberValueService } from "./services/memberValueService";
import { xmlaSyncService } from "./services/xmlaSyncService";

if (!env.publicUrl) {
  console.error("ERROR: La variable PUBLIC_URL no está definida en el .env. El servidor no puede arrancar sin ella.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

// Inyectar la URL pública en el documento Swagger para que apunte al servidor real.
const swaggerDocument = YAML.load(path.resolve(process.cwd(), "swagger.yaml")) as Record<string, unknown>;
swaggerDocument.servers = [{ url: env.publicUrl, description: "Servidor activo" }];

// -- CORS (para front en otro dominio/puerto) ------------------------------
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

// Configuración pública para el frontend: devuelve la URL base de la API.
// El frontend puede llamar a este endpoint al arrancar para obtener la URL correcta
// sin necesidad de hardcodear "localhost" ni la IP del servidor.
app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    api_base_url: env.publicUrl,
    product_id: env.productId || null
  });
});

app.get("/chat", (_req: Request, res: Response) => {
  res.sendFile(path.resolve(process.cwd(), "public", "chat.html"));
});

// OpenAPI/Swagger spec — devuelve el documento ya con la URL pública inyectada (no el archivo crudo)
app.get("/api/docs/swagger.yaml", (_req: Request, res: Response) => {
  res.type("application/json");
  res.json(swaggerDocument);
});

// Swagger UI (visual)
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Perfil del usuario (Launcher) + flags para UI de reglas
app.get("/auth/me", authMiddleware, authMeController);

// Rutas protegidas — requieren token válido del API Launcher
app.post("/ask", authMiddleware, askController);

app.get("/api/chat/conversations", authMiddleware, listConversationsController);
app.post("/api/chat/conversations", authMiddleware, createConversationController);
app.delete("/api/chat/conversations/:id", authMiddleware, deleteConversationController);
app.get("/api/chat/conversations/:id/messages", authMiddleware, listMessagesController);
app.post("/api/chat/ask", authMiddleware, askInConversationController);

// Reglas globales de negocio/sistema (lectura: autenticados; escritura: super_admin)
app.get("/api/global-rules", authMiddleware, listGlobalRulesController);
app.post("/api/global-rules", authMiddleware, requireSuperAdmin, createGlobalRuleController);
app.patch("/api/global-rules/:id", authMiddleware, requireSuperAdmin, updateGlobalRuleController);
app.delete("/api/global-rules/:id", authMiddleware, requireSuperAdmin, deleteGlobalRuleController);

// Reglas por cliente (solo super_admin; creación valida producto NLQ en Launcher)
app.get("/api/customer-rules", authMiddleware, requireSuperAdmin, listCustomerRulesController);
app.post("/api/customer-rules", authMiddleware, requireSuperAdmin, createCustomerRuleController);
app.patch("/api/customer-rules/:id", authMiddleware, requireSuperAdmin, updateCustomerRuleController);
app.delete("/api/customer-rules/:id", authMiddleware, requireSuperAdmin, deleteCustomerRuleController);

// Proxy listado/detalle de clientes Launcher (selector UI para reglas por cliente)
app.get("/api/admin/customers", authMiddleware, requireSuperAdmin, listAdminCustomersController);
app.get("/api/admin/customers/:id", authMiddleware, requireSuperAdmin, getAdminCustomerController);

// Admin: cobertura y re-sync de member values (sin auth, solo uso interno/servidor)
app.get("/api/admin/member-values/coverage", async (_req, res) => {
  try {
    const data = await memberValueService.coverage();
    const total = data.reduce((s, r) => s + r.members, 0);
    res.json({ total_members: total, cubes: data });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/admin/member-values/sync", async (_req, res) => {
  try {
    console.log("[memberValues] Re-sync solicitado via API admin...");
    const result = await memberValueService.syncFromSsas(
      (requestType, restrictions, catalog) =>
        xmlaSyncService.discoverRows(requestType, restrictions, catalog)
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Debug — solo accesible internamente (sin auth para facilitar monitoreo)
app.get("/api/debug/logs", getDebugLogsController);
app.get("/api/debug/summary", getDebugSummaryController);

app.listen(env.port, () => {
  console.log(`API listening on port ${env.port}`);
  console.log(`Public URL: ${env.publicUrl}`);
  console.log(`Chat UI:    ${env.publicUrl}/chat`);
  console.log(`Swagger UI: ${env.publicUrl}/api/docs`);
  console.log(`Log viewer: ${env.publicUrl}/logs.html`);
  if (env.bypassAuth) {
    console.warn("[auth] [WARN] BYPASS_AUTH=true — autenticación DESACTIVADA (solo desarrollo)");
  } else {
    console.log(`[auth] Autenticación activa via API Launcher: ${env.apiLauncherEndpoint}`);
    console.log(`[auth] Producto ID: ${env.productId}`);
  }
});
