import type { Request, Response } from "express";
import {
  customerRulesService,
  customerHasNlqProduct
} from "../services/customerRulesService";
import { debugLogger } from "../services/debugLogger";

export async function listCustomerRulesController(req: Request, res: Response): Promise<Response> {
  try {
    const customerId = String(req.query.customer_id ?? "").trim();
    if (!customerId) {
      return res.status(400).json({ error: "Query parameter customer_id is required." });
    }
    const limit = Number(req.query.limit ?? 200);
    const rules = await customerRulesService.listByCustomer(customerId, limit);
    await debugLogger.log("chat", "customer_rules_list", { customer_id: customerId, count: rules.length });
    return res.status(200).json({ rules });
  } catch (error) {
    await debugLogger.log("chat", "customer_rules_list_error", { error: (error as Error).message });
    return res.status(500).json({ code: "CUSTOMER_RULES_LIST_ERROR", error: (error as Error).message });
  }
}

export async function createCustomerRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const token = req.launcherToken;
    if (!token) {
      return res.status(401).json({ error: "ERR_UNAUTHORIZED", message: "Token no disponible." });
    }

    const customer_id = String(req.body?.customer_id ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    const content = String(req.body?.content ?? "").trim();
    const is_active = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : true;
    const priority = req.body?.priority !== undefined ? Number(req.body.priority) : 100;

    if (!customer_id) return res.status(400).json({ error: "Field 'customer_id' is required." });
    if (!name) return res.status(400).json({ error: "Field 'name' is required." });
    if (!content) return res.status(400).json({ error: "Field 'content' is required." });

    const okProduct = await customerHasNlqProduct(token, customer_id);
    if (!okProduct) {
      return res.status(403).json({
        error: "CUSTOMER_NO_NLQ_PRODUCT",
        message: "El cliente no tiene asignado el producto NLQ o no existe."
      });
    }

    const createdBy = req.userId ?? "unknown";
    const rule = await customerRulesService.create({
      customer_id,
      name,
      content,
      is_active,
      priority,
      created_by_user_id: createdBy
    });
    await debugLogger.log("chat", "customer_rule_create", { rule_id: rule.id, customer_id });
    return res.status(201).json({ rule });
  } catch (error) {
    await debugLogger.log("chat", "customer_rule_create_error", { error: (error as Error).message });
    return res.status(500).json({ code: "CUSTOMER_RULE_CREATE_ERROR", error: (error as Error).message });
  }
}

export async function updateCustomerRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Rule id is required." });

    const patch: { name?: string; content?: string; is_active?: boolean; priority?: number } = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name);
    if (req.body?.content !== undefined) patch.content = String(req.body.content);
    if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
    if (req.body?.priority !== undefined) patch.priority = Number(req.body.priority);

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No fields to update." });
    }

    const updated = await customerRulesService.update(id, patch);
    if (!updated) return res.status(404).json({ error: "Rule not found." });

    await debugLogger.log("chat", "customer_rule_update", { rule_id: id });
    return res.status(200).json({ rule: updated });
  } catch (error) {
    await debugLogger.log("chat", "customer_rule_update_error", { error: (error as Error).message });
    return res.status(500).json({ code: "CUSTOMER_RULE_UPDATE_ERROR", error: (error as Error).message });
  }
}

export async function deleteCustomerRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Rule id is required." });

    const removed = await customerRulesService.remove(id);
    if (!removed) return res.status(404).json({ error: "Rule not found." });

    await debugLogger.log("chat", "customer_rule_delete", { rule_id: id });
    return res.status(200).json({ ok: true, id });
  } catch (error) {
    await debugLogger.log("chat", "customer_rule_delete_error", { error: (error as Error).message });
    return res.status(500).json({ code: "CUSTOMER_RULE_DELETE_ERROR", error: (error as Error).message });
  }
}
