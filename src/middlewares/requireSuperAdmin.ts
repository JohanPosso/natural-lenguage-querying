import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "../services/launcherUserService";

/**
 * Debe ejecutarse después de authMiddleware.
 * Requiere req.launcherUser con role super_admin.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const u = req.launcherUser;
  if (!u) {
    res.status(503).json({
      error: "ERR_PROFILE_UNAVAILABLE",
      message: "No se pudo verificar el rol de usuario. Vuelve a iniciar sesión."
    });
    return;
  }
  if (!isSuperAdmin(u)) {
    res.status(403).json({
      error: "ERR_FORBIDDEN",
      message: "Se requiere rol super_admin."
    });
    return;
  }
  next();
}
