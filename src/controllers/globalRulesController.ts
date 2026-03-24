import type { Request, Response } from "express";
import { debugLogger } from "../services/debugLogger";
import { globalRulesService } from "../services/globalRulesService";

export async function listGlobalRulesController(req: Request, res: Response): Promise<Response> {
  try {
    const limit = Number(req.query.limit ?? 200);
    const rules = await globalRulesService.list(limit);
    await debugLogger.log("chat", "global_rules_list", { count: rules.length });
    return res.status(200).json({ rules });
  } catch (error) {
    await debugLogger.log("chat", "global_rules_list_error", { error: (error as Error).message });
    return res.status(500).json({ code: "GLOBAL_RULES_LIST_ERROR", error: (error as Error).message });
  }
}

export async function createGlobalRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const name = String(req.body?.name ?? "").trim();
    const content = String(req.body?.content ?? "").trim();
    const is_active = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : true;
    const priority = req.body?.priority !== undefined ? Number(req.body.priority) : 100;

    if (!name) return res.status(400).json({ error: "Field 'name' is required." });
    if (!content) return res.status(400).json({ error: "Field 'content' is required." });

    const rule = await globalRulesService.create({ name, content, is_active, priority });
    await debugLogger.log("chat", "global_rule_create", { rule_id: rule.id, name: rule.name });
    return res.status(201).json({ rule });
  } catch (error) {
    await debugLogger.log("chat", "global_rule_create_error", { error: (error as Error).message });
    return res.status(500).json({ code: "GLOBAL_RULE_CREATE_ERROR", error: (error as Error).message });
  }
}

export async function updateGlobalRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Rule id is required." });

    const patch: { name?: string; content?: string; is_active?: boolean; priority?: number } = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name);
    if (req.body?.content !== undefined) patch.content = String(req.body.content);
    if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
    if (req.body?.priority !== undefined) patch.priority = Number(req.body.priority);

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No fields to update. Provide name/content/is_active/priority." });
    }

    const updated = await globalRulesService.update(id, patch);
    if (!updated) return res.status(404).json({ error: "Rule not found." });

    await debugLogger.log("chat", "global_rule_update", { rule_id: id });
    return res.status(200).json({ rule: updated });
  } catch (error) {
    await debugLogger.log("chat", "global_rule_update_error", { error: (error as Error).message });
    return res.status(500).json({ code: "GLOBAL_RULE_UPDATE_ERROR", error: (error as Error).message });
  }
}

export async function deleteGlobalRuleController(req: Request, res: Response): Promise<Response> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Rule id is required." });

    const removed = await globalRulesService.remove(id);
    if (!removed) return res.status(404).json({ error: "Rule not found." });

    await debugLogger.log("chat", "global_rule_delete", { rule_id: id });
    return res.status(200).json({ ok: true, id });
  } catch (error) {
    await debugLogger.log("chat", "global_rule_delete_error", { error: (error as Error).message });
    return res.status(500).json({ code: "GLOBAL_RULE_DELETE_ERROR", error: (error as Error).message });
  }
}

