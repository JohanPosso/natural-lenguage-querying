import type { Request, Response } from "express";
import { isSuperAdmin } from "../services/launcherUserService";

/**
 * Perfil del usuario autenticado + flags para la UI de reglas.
 * El front puede usar `canManageRules` (camelCase) o `can_manage_*`.
 */
export async function authMeController(req: Request, res: Response): Promise<Response> {
  const u = req.launcherUser;
  if (!u) {
    return res.status(503).json({
      error: "ERR_PROFILE_UNAVAILABLE",
      message: "No se pudo cargar el perfil de usuario desde el Launcher."
    });
  }

  const superAdmin = isSuperAdmin(u);

  return res.status(200).json({
    user: {
      id: u.id,
      email: u.email,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
      username: u.username ?? null,
      role: u.role,
      customerId: u.customerId ?? null,
      products: u.products ?? []
    },
    can_manage_global_rules: superAdmin,
    can_manage_customer_rules: superAdmin,
    canManageRules: superAdmin
  });
}
