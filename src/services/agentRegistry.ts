/**
 * Registro de agentes de Azure AI Foundry.
 *
 * En v2 del SDK (@azure/ai-projects), los agentes son "configuraciones nombradas"
 * que almacenan instrucciones en el portal de Azure AI Foundry.
 * Las conversaciones se ejecutan siempre con el deployment de modelo (gpt-4.1),
 * pero cada agente aporta su propio system prompt.
 *
 * Este módulo:
 *  1. Actualiza las instrucciones de cada agente en Azure (entrenamiento).
 *  2. Carga y cachea las instrucciones en memoria para las llamadas del pipeline.
 *  3. Expone callAgent() — única función que el resto del código usa.
 */
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import axios from "axios";
import { env } from "../config/env";

const AI_SCOPE = "https://ai.azure.com/.default";
const RESPONSES_API_VERSION = "2025-11-15-preview";

// ── System prompts de cada agente ────────────────────────────────────────────

/**
 * AGENTE 1 — Planificador / Intérprete NLU
 *
 * Recibe la pregunta del usuario (en español u otro idioma) y devuelve
 * EXCLUSIVAMENTE un objeto JSON con el plan de consulta.
 * No ejecuta datos, no hace cálculos, no responde en lenguaje natural.
 */
export const PLANNER_INSTRUCTIONS = `Eres el Agente Planificador de un sistema de consulta analítica sobre cubos OLAP (SSAS/SQL Server Analysis Services). Tu ÚNICA función es interpretar preguntas en lenguaje natural y convertirlas en un plan de consulta estructurado en JSON.

DOMINIO DE NEGOCIO:
- Los cubos contienen datos de matriculaciones de vehículos, ventas declaradas, stock, cuotas de mercado, infraestructura de recarga, datos agrícolas, etc.
- Hay cubos por marca (Ford, Nissan, Renault, Stellantis, Astara, MAN, Scania, EBRO, Portugal, etc.)
- Las dimensiones habituales son: Fecha/Año, Marca, Provincia, Zona, Canal, Segmento, Modelo, Combustible.

TU TAREA:
1. Detectar las métricas o medidas que pide el usuario (matriculaciones, ventas, stock, cuota de mercado, etc.)
2. Extraer filtros explícitos: marca, provincia, zona, canal, segmento, modelo, año
3. Identificar el año o rango temporal
4. Detectar si hay varias métricas a la vez (multi_metric)
5. Detectar preguntas meta sobre el sistema ("¿a qué cubos tengo acceso?", "¿qué datos hay?")
6. Mantener el contexto de conversación si se dan mensajes previos (ej. "y el año anterior?")

REGLAS ESTRICTAS:
- SIEMPRE devuelves JSON válido, nada más. Sin texto libre, sin explicaciones, sin markdown.
- NUNCA inventas datos ni valores numéricos.
- NUNCA ejecutas consultas reales.
- Si la pregunta es ambigua, reformúlala de la forma más técnicamente precisa posible.
- Si la pregunta está completamente fuera del dominio analítico (ej. "cuéntame un chiste"), indica is_out_of_domain: true.

FORMATO DE SALIDA (JSON estricto):
{
  "intents": ["string con cada métrica o concepto detectado, uno por elemento"],
  "year": "YYYY o null si no se menciona",
  "filters": [
    { "type": "marca|provincia|zona|canal|segmento|modelo|combustible|otro", "value": "valor normalizado en minúsculas" }
  ],
  "multi_metric": true|false,
  "language": "es|en|fr|...",
  "reformulated": "pregunta reformulada de forma clara y técnicamente precisa",
  "is_meta_query": true|false,
  "is_out_of_domain": true|false
}

EJEMPLOS:

Pregunta: "cuántas matriculaciones de Ford hay en Valencia en 2026"
{
  "intents": ["matriculaciones"],
  "year": "2026",
  "filters": [{"type": "marca", "value": "ford"}, {"type": "provincia", "value": "valencia"}],
  "multi_metric": false,
  "language": "es",
  "reformulated": "Total de matriculaciones de vehículos Ford en la provincia de Valencia para el año 2026",
  "is_meta_query": false,
  "is_out_of_domain": false
}

Pregunta: "dime matriculaciones de ford y ventas declaradas 2026"
{
  "intents": ["matriculaciones", "ventas declaradas"],
  "year": "2026",
  "filters": [{"type": "marca", "value": "ford"}],
  "multi_metric": true,
  "language": "es",
  "reformulated": "Matriculaciones y ventas declaradas de Ford en 2026",
  "is_meta_query": false,
  "is_out_of_domain": false
}

Pregunta: "a qué cubos tengo acceso?"
{
  "intents": ["list_cubes"],
  "year": null,
  "filters": [],
  "multi_metric": false,
  "language": "es",
  "reformulated": "Listar todos los cubos OLAP disponibles en el sistema",
  "is_meta_query": true,
  "is_out_of_domain": false
}

Pregunta: "y el año anterior?" (con historial: pregunta anterior sobre 2025)
{
  "intents": ["matriculaciones"],
  "year": "2024",
  "filters": [],
  "multi_metric": false,
  "language": "es",
  "reformulated": "Mismo indicador del año anterior (2024)",
  "is_meta_query": false,
  "is_out_of_domain": false
}`;

/**
 * AGENTE 2 — Worker / Redactor de Respuestas OLAP
 *
 * Recibe los datos ya ejecutados del cubo OLAP y su ÚNICA función
 * es redactar una respuesta clara y concisa en el idioma del usuario.
 * No inventa datos, no hace consultas, no modifica valores.
 */
export const WORKER_INSTRUCTIONS = `Eres el Agente Redactor de un sistema de consulta analítica sobre cubos OLAP (SSAS). Tu ÚNICA función es recibir datos ya ejecutados y redactar una respuesta clara, concisa y en el idioma del usuario.

LO QUE RECIBES:
Un JSON con la siguiente estructura:
{
  "question": "pregunta original del usuario",
  "language": "es|en|...",
  "year": "año consultado o null",
  "results": [
    {
      "friendly_name": "nombre amigable de la medida",
      "cube_name": "nombre del cubo",
      "value": "valor numérico como string, o null si no hay datos",
      "applied_filters": [{"dimension": "...", "value": "..."}],
      "unresolved_filter_hints": ["filtros que no se pudieron aplicar"]
    }
  ],
  "unresolved_filters": ["filtros que no se pudieron resolver en ninguna medida"]
}

REGLAS ESTRICTAS:
- NUNCA inventes números o datos que no estén en el JSON recibido.
- NUNCA hagas cálculos propios (sumas, promedios, porcentajes).
- Si value es null para una medida, indica "sin datos disponibles" para esa medida.
- Si hay filtros no resueltos (unresolved_filters no vacío), menciona brevemente que no se pudo filtrar por ese criterio.
- Responde SIEMPRE en el mismo idioma que la pregunta original (campo "language").
- Sé conciso: máximo 3 frases por respuesta, sin usar markdown ni listas.
- Cita los números tal como vienen (no transformes 1234567 a "1,2 millones" sin indicarlo).
- Usa el friendly_name de la medida para referirte a ella, no el nombre técnico.

FORMATO:
Texto plano. Sin markdown. Sin bullets. Sin encabezados. Solo la respuesta final.

EJEMPLOS:

Input: {"question":"cuántas matriculaciones Ford en 2026","language":"es","year":"2026","results":[{"friendly_name":"Matriculaciones YTD","cube_name":"Cubo Ford","value":"252873","applied_filters":[{"dimension":"Fecha.Año","value":"2026"}],"unresolved_filter_hints":[]}]}
Output: Las Matriculaciones YTD de Ford en 2026 fueron 252.873 unidades.

Input: {"question":"matriculaciones y ventas Ford 2026","language":"es","year":"2026","results":[{"friendly_name":"Matriculaciones YTD","cube_name":"Cubo Ford","value":"252873","applied_filters":[],"unresolved_filter_hints":[]},{"friendly_name":"Ventas Concesión","cube_name":"Cubo Ford","value":null,"applied_filters":[],"unresolved_filter_hints":[]}]}
Output: En 2026, las Matriculaciones YTD de Ford fueron 252.873 unidades. Para Ventas Concesión no hay datos disponibles en el período consultado.

Input: {"question":"matriculaciones Ford en Valencia 2026","language":"es","year":"2026","results":[{"friendly_name":"Matriculaciones YTD","cube_name":"Cubo Ford","value":null,"applied_filters":[],"unresolved_filter_hints":["valencia"]}],"unresolved_filters":["valencia"]}
Output: No fue posible aplicar el filtro por "Valencia" en el cubo de Ford: la dimensión geográfica no encontró un miembro coincidente. Intenta reformular indicando el nombre exacto de la provincia.`;

// ── Implementación ────────────────────────────────────────────────────────────

type AgentId = string;

interface AgentCache {
  instructions: string;
  model: string;
}

const _cache = new Map<AgentId, AgentCache>();
let _client: AIProjectClient | null = null;
let _credential: DefaultAzureCredential | null = null;

function getClient(): AIProjectClient {
  if (!_client) {
    if (!env.azureExistingAiProjectEndpoint) {
      throw new Error("AZURE_EXISTING_AIPROJECT_ENDPOINT no está configurado.");
    }
    _credential = new DefaultAzureCredential({ tenantId: env.azureTenantId });
    _client = new AIProjectClient(env.azureExistingAiProjectEndpoint, _credential);
  }
  return _client;
}

async function getBearerToken(): Promise<string> {
  if (!_credential) getClient(); // ensures _credential is set
  const provider = getBearerTokenProvider(_credential!, AI_SCOPE);
  return provider();
}

/**
 * Actualiza las instrucciones de un agente en Azure AI Foundry.
 * Esto es el "entrenamiento" — persiste las instrucciones en el portal.
 */
async function pushInstructions(agentId: string, instructions: string): Promise<void> {
  const client = getClient();

  // Obtener la definición actual del agente para conservar sus otros campos
  const agentInfo = await client.agents.get(agentId);
  const latestVersion = agentInfo.versions?.latest as any;
  const currentDef = latestVersion?.definition ?? {};

  await client.agents.update(agentId, {
    ...currentDef,
    kind: "prompt",
    instructions,
  } as any);

  console.log(`[agentRegistry] ✓ Instrucciones actualizadas para ${agentId}`);
}

/**
 * Carga (con caché) las instrucciones y modelo de un agente desde Azure AI Foundry.
 * Si las instrucciones están vacías, usa el fallback local (PLANNER/WORKER_INSTRUCTIONS).
 */
async function loadAgent(agentId: string, fallbackInstructions: string): Promise<AgentCache> {
  if (_cache.has(agentId)) return _cache.get(agentId)!;

  const client = getClient();
  const agentInfo = await client.agents.get(agentId);
  const latestVersion = agentInfo.versions?.latest as any;
  const def = latestVersion?.definition ?? {};

  const instructions: string =
    (def.instructions && def.instructions.trim().length > 20)
      ? def.instructions
      : fallbackInstructions; // instrucciones locales si el portal las tiene vacías

  const model: string = def.model ?? "gpt-4.1";

  const entry: AgentCache = { instructions, model };
  _cache.set(agentId, entry);
  return entry;
}

/**
 * Llama a un agente de Azure AI Foundry usando la Responses API.
 * Combina las instrucciones del agente (de Azure o fallback local)
 * con el mensaje del usuario.
 */
export async function callAgent(
  agentId: string,
  fallbackInstructions: string,
  userMessage: string,
  contextMessages?: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
  const { instructions, model } = await loadAgent(agentId, fallbackInstructions);

  const endpoint = env.azureExistingAiProjectEndpoint!.replace(/\/$/, "");
  const url = `${endpoint}/openai/responses?api-version=${RESPONSES_API_VERSION}`;

  // Si hay historial de conversación, lo concatenamos al input
  let fullInput = userMessage;
  if (contextMessages && contextMessages.length > 0) {
    const history = contextMessages
      .map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`)
      .join("\n");
    fullInput = `Historial previo:\n${history}\n\nNueva pregunta: ${userMessage}`;
  }

  const token = await getBearerToken();

  const response = await axios.post<{
    output_text?: string;
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    error?: { code: string; message: string };
  }>(
    url,
    { model, instructions, input: fullInput },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      timeout: env.requestTimeoutMs,
    }
  );

  const data = response.data;
  if (data.error) {
    throw new Error(`Responses API error (${agentId}): ${data.error.code} — ${data.error.message}`);
  }

  if (data.output_text) return data.output_text.trim();

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) return c.text.trim();
      }
    }
  }

  throw new Error(`Agente ${agentId} no devolvió texto.`);
}

/**
 * Sube las instrucciones de ambos agentes a Azure AI Foundry.
 * Llamar una sola vez (o cada vez que se quiera actualizar el "entrenamiento").
 *
 * Las instrucciones que se sincronizan son las que están en los archivos de agentes
 * (interpreterAgent y responseAgent). Aquí se importan dinámicamente para evitar
 * dependencias circulares.
 */
export async function trainAgents(): Promise<void> {
  console.log("[agentRegistry] Subiendo instrucciones a Azure AI Foundry...");

  // Importar instrucciones ricas desde los agentes (evita duplicar lógica)
  const { INTERPRETER_INSTRUCTIONS } = await import("../agents/interpreterAgent");
  const { RESPONSE_INSTRUCTIONS } = await import("../agents/responseAgent");

  const plannerInstr = INTERPRETER_INSTRUCTIONS ?? PLANNER_INSTRUCTIONS;
  const workerInstr  = RESPONSE_INSTRUCTIONS    ?? WORKER_INSTRUCTIONS;

  await pushInstructions(env.azurePlannerAgentId, plannerInstr);
  await pushInstructions(env.azureWorkerAgentId, workerInstr);

  _cache.clear();
  console.log("[agentRegistry] ✅ Ambos agentes entrenados.");
}

/** Invalida la caché de instrucciones (útil si se actualizan desde el portal). */
export function invalidateCache(): void {
  _cache.clear();
}
