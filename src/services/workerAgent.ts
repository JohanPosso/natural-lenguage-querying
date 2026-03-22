/**
 * Agente 2 — Worker / Redactor de Respuestas OLAP
 *
 * Responsabilidad: recibir los datos ya ejecutados del pipeline OLAP
 * y redactar una respuesta en lenguaje natural para el usuario.
 * No ejecuta consultas, no inventa datos.
 *
 * Agente Azure: agent-dev360-Worker-1 (AZURE_WORKER_AGENT_ID)
 */
import { callAgent, WORKER_INSTRUCTIONS } from "./agentRegistry";
import { env } from "../config/env";

export interface MeasureResultForWorker {
  friendly_name: string;
  cube_name: string;
  value: string | null;
  applied_filters: Array<{ dimension: string; value: string }>;
  unresolved_filter_hints: string[];
}

export interface WorkerInput {
  question: string;
  language: string;
  year: string | null;
  results: MeasureResultForWorker[];
  unresolved_filters?: string[];
}

/**
 * Genera la respuesta en lenguaje natural a partir de los datos ejecutados.
 *
 * @param input  Datos del pipeline (pregunta, resultados de medidas, filtros)
 */
export async function buildResponse(input: WorkerInput): Promise<string> {
  const userMessage = JSON.stringify(input);

  const answer = await callAgent(
    env.azureWorkerAgentId,
    WORKER_INSTRUCTIONS,
    userMessage
  );

  return answer;
}
