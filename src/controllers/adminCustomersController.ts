import type { Request, Response } from "express";
import axios from "axios";
import { env } from "../config/env";
import { customerHasNlqProduct } from "../services/customerRulesService";

/**
 * Lista clientes (proxy al Launcher). Query: query, limit, page — mismos que el Launcher.
 */
export async function listAdminCustomersController(req: Request, res: Response): Promise<Response> {
  try {
    const token = req.launcherToken;
    if (!token) {
      return res.status(401).json({ error: "ERR_UNAUTHORIZED", message: "Token no disponible." });
    }
    if (!env.apiLauncherEndpoint) {
      return res.status(500).json({ error: "API_LAUNCHER_ENDPOINT no configurado." });
    }

    const query = String(req.query.query ?? "");
    const limit = String(req.query.limit ?? "100");
    const page = String(req.query.page ?? "1");

    const base = env.apiLauncherEndpoint.replace(/\/$/, "");
    const url = `${base}/customers?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}&page=${encodeURIComponent(page)}`;

    const response = await axios.get(url, {
      headers: { Token: token },
      timeout: 20_000,
      validateStatus: (s) => s < 500
    });

    return res.status(response.status).json(response.data);
  } catch (error) {
    const err = error as { response?: { status?: number; data?: unknown }; message?: string };
    if (err.response?.status) {
      return res.status(err.response.status).json(err.response.data ?? { error: err.message });
    }
    return res.status(500).json({ error: "ADMIN_CUSTOMERS_LIST_ERROR", message: (error as Error).message });
  }
}

/**
 * Detalle de un cliente + flag si tiene el producto NLQ (PRODUCT_ID del servidor).
 */
export async function getAdminCustomerController(req: Request, res: Response): Promise<Response> {
  try {
    const token = req.launcherToken;
    if (!token) {
      return res.status(401).json({ error: "ERR_UNAUTHORIZED", message: "Token no disponible." });
    }
    const customerId = String(req.params.id ?? "").trim();
    if (!customerId) {
      return res.status(400).json({ error: "Customer id is required." });
    }
    if (!env.apiLauncherEndpoint) {
      return res.status(500).json({ error: "API_LAUNCHER_ENDPOINT no configurado." });
    }

    const base = env.apiLauncherEndpoint.replace(/\/$/, "");
    const url = `${base}/customers/${encodeURIComponent(customerId)}`;

    const response = await axios.get(url, {
      headers: { Token: token },
      timeout: 20_000,
      validateStatus: (s) => s === 200 || s === 404
    });

    if (response.status === 404) {
      return res.status(404).json({ error: "CUSTOMER_NOT_FOUND" });
    }

    const hasNlq = await customerHasNlqProduct(token, customerId);
    const payload = response.data as { data?: { customer?: unknown } };

    return res.status(200).json({
      ...payload,
      has_nlq_product: hasNlq
    });
  } catch (error) {
    return res.status(500).json({
      error: "ADMIN_CUSTOMER_GET_ERROR",
      message: (error as Error).message
    });
  }
}
