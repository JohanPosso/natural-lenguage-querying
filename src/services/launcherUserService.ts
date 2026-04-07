import axios from "axios";
import { env } from "../config/env";

/** Usuario devuelto por GET {API_LAUNCHER}/users/:userId */
export type LauncherUser = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  role: string;
  languageCode?: string;
  customerId?: string | null;
  products?: string[];
};

type LauncherUserResponse = {
  success?: boolean;
  data?: { user?: LauncherUser };
};

/**
 * Obtiene el perfil del usuario desde el API Launcher (sin modificar el Launcher).
 * Ruta: GET {API_LAUNCHER_ENDPOINT}/users/{userId} con header Token.
 */
export async function fetchLauncherUser(token: string, userId: string): Promise<LauncherUser | null> {
  if (!env.apiLauncherEndpoint) {
    throw new Error("API_LAUNCHER_ENDPOINT no está configurado.");
  }

  const base = env.apiLauncherEndpoint.replace(/\/$/, "");
  const url = `${base}/users/${encodeURIComponent(userId)}`;

  const response = await axios.get<LauncherUserResponse>(url, {
    headers: { Token: token },
    timeout: 12_000,
    validateStatus: (s) => s === 200 || s === 404
  });

  if (response.status !== 200 || !response.data?.data?.user) {
    return null;
  }

  const u = response.data.data.user;
  return {
    id: String(u.id),
    email: String(u.email ?? ""),
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    role: String(u.role ?? ""),
    languageCode: u.languageCode,
    customerId: u.customerId != null && u.customerId !== "" ? String(u.customerId) : null,
    products: Array.isArray(u.products) ? u.products.map(String) : []
  };
}

export function isSuperAdmin(user: LauncherUser | undefined): boolean {
  return String(user?.role ?? "").toLowerCase() === "super_admin";
}
