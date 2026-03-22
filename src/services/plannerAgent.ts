/**
 * Agente 1 — Planificador / Intérprete NLU
 *
 * Responsabilidad: convertir la pregunta del usuario en un plan de consulta
 * estructurado (JSON). No ejecuta datos, no responde en lenguaje natural.
 *
 * Agente Azure: agent-dev360 (AZURE_PLANNER_AGENT_ID)
 */
import { callAgent, PLANNER_INSTRUCTIONS } from "./agentRegistry";
import { env } from "../config/env";

export interface QueryPlan {
  intents: string[];
  year: string | null;
  filters: Array<{ type: string; value: string }>;
  multi_metric: boolean;
  language: string;
  reformulated: string;
  is_meta_query: boolean;
  is_out_of_domain: boolean;
}

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  const bare = raw.match(/(\{[\s\S]*\})/);
  if (bare) return bare[1];
  return raw;
}

/**
 * Interpreta una pregunta en lenguaje natural y devuelve un plan estructurado.
 *
 * @param question  Pregunta del usuario
 * @param history   Mensajes anteriores de la conversación (para contexto de follow-ups)
 */
export async function planQuery(
  question: string,
  history: ConversationTurn[] = []
): Promise<QueryPlan> {
  const raw = await callAgent(
    env.azurePlannerAgentId,
    PLANNER_INSTRUCTIONS,
    question,
    history
  );

  const jsonStr = extractJson(raw);

  let plan: QueryPlan;
  try {
    plan = JSON.parse(jsonStr) as QueryPlan;
  } catch (err) {
    throw new Error(
      `Agente Planificador devolvió JSON inválido: ${(err as Error).message}. ` +
        `Respuesta: ${raw.slice(0, 300)}`
    );
  }

  // Normalizar campos opcionales
  plan.intents = plan.intents ?? [];
  plan.filters = plan.filters ?? [];
  plan.year = plan.year ?? null;
  plan.multi_metric = plan.multi_metric ?? plan.intents.length > 1;
  plan.language = plan.language ?? "es";
  plan.reformulated = plan.reformulated ?? question;
  plan.is_meta_query = plan.is_meta_query ?? false;
  plan.is_out_of_domain = plan.is_out_of_domain ?? false;

  return plan;
}
