/**
 * Middleware de autenticación usando el API Launcher de la empresa.
 *
 * Flujo:
 * 1. Lee el header `Authorization: Bearer <token>`
 * 2. Decodifica el JWT localmente (sin verificar firma) para extraer `userId`
 * 3. Llama al API Launcher para obtener los permisos del usuario sobre el producto (ID_CUBE)
 * 4. Extrae `allowedCubes` de la respuesta y los almacena en `req.allowedCubes`
 * 5. Si `BYPASS_AUTH=true`, omite toda validación (solo para entornos de desarrollo)
 */

import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

// ── Tipos internos ───────────────────────────────────────────────────────────

interface LauncherCube {
  name: string;
  GUID: string;
}

interface LauncherModuleConfig {
  allowed_cubes?: LauncherCube[];
  analisys_feature?: string;
  analysis_feature?: string;
  export_feature?: string;
  premium_feature?: string;
}

interface LauncherPermissions {
  territories?: Record<string, string[]>;
  apppermisionsmodules: Record<string, LauncherModuleConfig | LauncherModuleConfig[]>;
}

interface LauncherResponse {
  data: {
    permissions: LauncherPermissions;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decodifica el payload de un JWT sin verificar la firma.
 * El API Launcher es quien realmente valida el token.
 */
function decodeTokenPayload(token: string): { userId: string; exp?: number } {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== "object" || !("userId" in decoded)) {
      throw new Error("Token inválido: falta userId en el payload");
    }
    return decoded as { userId: string; exp?: number };
  } catch {
    throw new Error("Token JWT malformado");
  }
}

/**
 * Consulta al API Launcher los permisos del usuario sobre el producto configurado.
 * Si el Launcher devuelve 401/403, ese error se propaga al cliente.
 */
async function fetchPermissionsFromLauncher(
  token: string,
  userId: string
): Promise<LauncherPermissions> {
  const { apiLauncherEndpoint, productId } = env;

  if (!apiLauncherEndpoint || !productId) {
    throw new Error(
      "API_LAUNCHER_ENDPOINT o PRODUCT_ID no están configurados en las variables de entorno"
    );
  }

  const response = await axios.get<LauncherResponse>(
    `${apiLauncherEndpoint}/products/parameters/access/${productId}?userId=${userId}`,
    {
      headers: { token },
      timeout: 10_000,
    }
  );

  return response.data.data.permissions;
}

/**
 * Extrae la lista de nombres de cubos permitidos de la respuesta del Launcher.
 * El módulo ID_CUBE puede ser un objeto o un array — se normaliza en ambos casos.
 */
function extractAllowedCubes(permissions: LauncherPermissions): string[] {
  const moduleRaw = permissions.apppermisionsmodules?.["ID_CUBE"];
  if (!moduleRaw) return [];

  const moduleConfig = Array.isArray(moduleRaw) ? moduleRaw[0] : moduleRaw;
  return (moduleConfig.allowed_cubes ?? []).map((c) => c.name);
}

// ── Middleware ────────────────────────────────────────────────────────────────

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // En modo de desarrollo se puede omitir la autenticación
  if (env.bypassAuth) {
    console.warn("[auth] BYPASS_AUTH activo — omitiendo validación de token");
    req.userId = "bypass-user";
    req.allowedCubes = null; // null = acceso a todos los cubos
    return next();
  }

  const authHeader = req.headers.authorization;

  // Si no hay header pero hay token de prueba configurado, usarlo como fallback
  let token: string;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    if (env.devTestToken) {
      console.warn("[auth] Sin header Authorization — usando DEV_TEST_TOKEN del .env");
      token = env.devTestToken;
    } else {
      res.status(401).json({
        error: "ERR_UNAUTHORIZED",
        message: "Se requiere el header Authorization: Bearer <token>",
      });
      return;
    }
  } else {
    token = authHeader.slice(7); // quitar "Bearer "
  }

  try {
    // 1. Extraer userId del JWT sin validar firma
    const { userId } = decodeTokenPayload(token);

    // 2. Validar token y obtener permisos desde el API Launcher
    const permissions = await fetchPermissionsFromLauncher(token, userId);

    // 3. Extraer cubos permitidos
    const allowedCubes = extractAllowedCubes(permissions);

    req.userId = userId;
    req.allowedCubes = allowedCubes;

    console.log(
      `[auth] Usuario ${userId} autenticado — cubos permitidos: [${allowedCubes.join(", ") || "ninguno"}]`
    );

    next();
  } catch (err) {
    const error = err as { response?: { status?: number; data?: unknown }; message?: string };

    // Si el Launcher rechazó el token, reenviar el mismo status al cliente
    if (error.response?.status === 401) {
      res.status(401).json({ error: "ERR_UNAUTHORIZED", message: "Token inválido o expirado" });
      return;
    }

    if (error.response?.status === 403) {
      res.status(403).json({ error: "ERR_FORBIDDEN", message: "Sin permisos para este producto" });
      return;
    }

    console.error("[auth] Error al validar token:", error.message ?? err);
    res.status(500).json({ error: "ERR_AUTH_FAILED", message: "Error al validar credenciales" });
  }
}
