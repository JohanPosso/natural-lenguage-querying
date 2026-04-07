import { globalRulesService } from "./globalRulesService";
import { customerRulesService } from "./customerRulesService";

/**
 * Concatena reglas globales + reglas del cliente para inyectar en prompts.
 */
export async function buildAllRulesPromptBlocks(customerId?: string | null): Promise<string> {
  const [globalBlock, customerBlock] = await Promise.all([
    globalRulesService.buildPromptBlock(),
    customerRulesService.buildPromptBlock(customerId ?? null)
  ]);
  return [globalBlock, customerBlock].filter((b) => b.trim().length > 0).join("\n\n");
}
