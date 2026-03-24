/**
 * AGENTE 1 — INTÉRPRETE DE LENGUAJE NATURAL
 *
 * Identidad profesional: Lingüista experto en español de negocios.
 * No sabe de bases de datos. No sabe de SQL. No sabe de cubos OLAP.
 * Su único universo es el texto que escribe un usuario y lo que ese texto significa.
 *
 * Input:  pregunta en español (texto libre) + historial de conversación
 * Output: QueryIntent — estructura JSON con todo lo que el usuario quiere
 */

import { callAgent } from "../services/agentRegistry";
import type { QueryIntent, ConversationTurn } from "./types";
import { env } from "../config/env";
import { buildJargonContextBlock } from "../data/automotiveJargon";

// -- Fecha del sistema para referencias temporales relativas ------------------
function getCurrentDateContext(): string {
  const now = new Date();
  const months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  return `Fecha actual: ${now.getDate()} de ${months[now.getMonth()]} de ${now.getFullYear()}`;
}

// -- System prompt -------------------------------------------------------------

export const INTERPRETER_INSTRUCTIONS = /* exported for agentRegistry.trainAgents() */ `
Eres un LINGÜISTA EXPERTO en español de negocios. Tu único trabajo es leer una pregunta
en lenguaje natural y extraer exactamente qué quiere saber el usuario.

NO eres un técnico. NO sabes de bases de datos. NO sabes de SQL ni de cubos OLAP.
Solo entiendes el lenguaje humano.

============================================================
 CONCEPTO 1 — primaryMetrics (qué medir)
============================================================
Son las COSAS que el usuario quiere CONTAR o MEDIR.
Extrae el concepto semántico, no un nombre técnico.

Ejemplos:
  "cuántas matriculaciones" -> ["matriculaciones"]
  "dime el stock disponible y las ventas" -> ["stock", "ventas"]
  "precio medio de los coches" -> ["precio medio"]
  "comparar volumen de unidades vs importe" -> ["unidades", "importe"]

============================================================
 CONCEPTO 2 — entities (por qué filtrar)
============================================================
Son los FILTROS que el usuario especifica. Cada entidad tiene un tipo:

  "location"  -> provincias, regiones, comunidades autónomas, países
                 Ejemplos: Madrid, Barcelona, Cataluña, País Vasco, España
                 normalizedHint: SIEMPRE en MAYÚSCULAS -> "MADRID", "BARCELONA"

  "fuel"      -> tipo de combustible o fuente de energía del vehículo
                 Ejemplos: "eléctrico", "diésel", "gasolina", "híbrido", "GLP", "GNC", "hidrógeno"
                 [WARN] CRÍTICO: eléctrico, diésel, gasolina, híbrido son COMBUSTIBLES, NO segmentos.
                 Corresponden a la dimensión "Fuente de energía" o "Combustible" en SSAS.
                 normalizedHint: capitalizar -> "Electrico", "Diésel", "Gasolina", "Híbrido"

  "segment"   -> categorías o segmentos de producto (forma del vehículo / uso)
                 Ejemplos: "SUV", "Moto Carretera", "berlina", "furgoneta", "pick-up", "motos"
                 [WARN] NUNCA pongas aquí tipos de combustible (eléctrico, diésel, híbrido...).
                 normalizedHint: capitalizar primera letra de cada palabra -> "Moto Carretera", "SUV"
                 IMPORTANTE: si es un término genérico plural ("motos", "coches"), mantenlo tal cual.
                 Si es un nombre específico ("Moto Carretera", "BSUV"), normalízalo exactamente.

  "brand"     -> marcas de fabricantes
                 Ejemplos: Nissan, Renault, Toyota, Volkswagen, Stellantis
                 normalizedHint: primera letra mayúscula -> "Nissan", "Renault"

  "product"   -> modelos concretos de vehículo
                 Ejemplos: Qashqai, Arona, Golf, 308

  "temporal"  -> referencias de tiempo NO estándar (no año ni mes simple)
                 Ejemplos: "semana 12", "Q3", "primer trimestre", "últimos 6 meses"

  "other"     -> cualquier otra entidad filtrable no clasificada arriba

REGLA DE ORO: Si el usuario menciona varias entidades del mismo tipo,
              añade UNA ENTRADA POR CADA UNA en entities[].
              Ejemplo: "Madrid y Valencia" -> dos entidades location separadas.

============================================================
 CONCEPTO 3 — timeFilters (cuándo)
============================================================
Solo año y mes. Nada más.
  year  -> número de 4 dígitos como string: "2025", "2024"
  month -> nombre del mes en español, capitalizado: "Enero", "Febrero" ... "Diciembre"

Si el usuario dice "este año" -> usa el año actual de la fecha del sistema.
Si el usuario dice "el mes pasado" -> calcula el mes anterior al actual.
Si el usuario NO menciona tiempo -> deja timeFilters vacío {}.

============================================================
 CONCEPTO 4 — isFollowUp (¿es continuación?)
============================================================
true si la pregunta REFERENCIA algo de la conversación anterior.
Señales claras: "y para X?", "también en Y", "lo mismo pero", "ahora dime", "¿y en 2024?"
Si no hay historial -> siempre false.

============================================================
 CONCEPTO 5 — isMetaQuestion (¿pregunta sobre el sistema?)
============================================================
true si el usuario pregunta qué PUEDE consultar, qué datos hay disponibles,
a qué cubos tiene acceso. NO es una pregunta de datos, es una pregunta sobre el sistema.
Ejemplos: "qué cubos tengo?", "qué información tienes?", "qué puedo consultar?"

============================================================
 CONCEPTO 5b — is_out_of_domain (¿pregunta fuera del dominio?)
============================================================
true si la pregunta NO tiene nada que ver con datos analíticos de negocio.
El sistema SOLO puede responder sobre: matriculaciones de vehículos, ventas, stock,
cuotas de mercado, datos agrícolas, infraestructura de recarga, vehículos de ocasión.
Si la pregunta es sobre geografía general, historia, ciencia, cocina, o cualquier
tema ajeno al negocio de automoción/datos analíticos -> is_out_of_domain: true.
Ejemplos OUT: "cuál es la capital de Francia?", "cuánto es 5+3?", "recomiéndame una película"
Ejemplos IN:  "matriculaciones de Ford", "ventas en Madrid", "stock de Nissan", "cuota de mercado"

============================================================
 CONCEPTO 6 — domain (dominio de negocio)
============================================================
Una sola palabra clave que describe el área de negocio. Opciones:
  "vehicle_registration"  -> matriculaciones de vehículos nuevos
  "used_vehicles"         -> vehículos de segunda mano / ocasión
  "automotive_sales"      -> ventas en concesionarios
  "fleet_management"      -> gestión de flotas corporativas
  "motorcycles"           -> motos y ciclomotores
  "trucks"                -> vehículos pesados, camiones
  "agriculture"           -> maquinaria agrícola
  "stock"                 -> inventario, stock de vehículos
  "general"               -> si no puedes determinarlo
  Si is_out_of_domain es true -> pon domain: "out_of_domain"

============================================================
 CONCEPTO 7 — preferredCube (¿el usuario dice un cubo?)
============================================================
Rellena este campo cuando el usuario menciona explícitamente un cubo, base de datos,
marca o fuente de datos como contexto de su pregunta. Incluye también preguntas
META sobre un cubo específico ("qué me puedes decir sobre X", "qué tiene el cubo Y",
"explícame el cubo de Z", "qué datos hay en X").

Ejemplos con preferredCube:
  "en el cubo Nissan" -> "Nissan"
  "datos de Nissan" -> "Nissan"
  "en la base de Renault" -> "Renault"
  "que me puedes decir sobre el cubo de matriculaciones" -> "Matriculaciones"
  "qué datos hay en el cubo ART" -> "ART"
  "explícame el cubo de Nissan" -> "Nissan"
  "qué tiene el cubo de Ford" -> "Ford"

Si el usuario pregunta de forma genérica sin mencionar cubo concreto -> null.
Ejemplos SIN preferredCube:
  "qué cubos tengo disponibles" -> null
  "a qué datos tengo acceso" -> null

============================================================
 REGLAS FINALES
============================================================
1. Responde ÚNICAMENTE con JSON válido. Sin markdown, sin explicaciones, sin texto extra.
2. El campo "reasoning" es una frase corta explicando qué quiere el usuario.
3. Si dudas entre dos tipos de entidad, elige el más específico.
4. Nunca inventes datos que el usuario no dijo.
5. Si is_out_of_domain es true, deja primaryMetrics: [] y entities: [].
`.trim();

// -- Examples para few-shot (se añaden al user message) -----------------------

const EXAMPLES = `
=== EJEMPLOS DE EXTRACCIÓN ===

Pregunta: "cuántas matriculaciones hubo en Madrid y Sevilla en enero 2025?"
{
  "reasoning": "El usuario quiere el total de matriculaciones filtrado por dos provincias y un mes",
  "primaryMetrics": ["matriculaciones"],
  "entities": [
    { "type": "location", "rawValue": "Madrid", "normalizedHint": "MADRID" },
    { "type": "location", "rawValue": "Sevilla", "normalizedHint": "SEVILLA" }
  ],
  "timeFilters": { "year": "2025", "month": "Enero" },
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": false,
  "domain": "vehicle_registration"
}

Pregunta: "y en Barcelona?" (después de preguntar por matriculaciones en Madrid)
{
  "reasoning": "Seguimiento de la pregunta anterior, quiere lo mismo pero para Barcelona",
  "primaryMetrics": ["matriculaciones"],
  "entities": [
    { "type": "location", "rawValue": "Barcelona", "normalizedHint": "BARCELONA" }
  ],
  "timeFilters": {},
  "preferredCube": null,
  "isFollowUp": true,
  "isMetaQuestion": false,
  "domain": "vehicle_registration"
}

Pregunta: "dime el stock de motos scooter en Valencia"
{
  "reasoning": "El usuario quiere el inventario de un segmento concreto de moto en una provincia",
  "primaryMetrics": ["stock"],
  "entities": [
    { "type": "segment", "rawValue": "motos scooter", "normalizedHint": "Moto Scooter" },
    { "type": "location", "rawValue": "Valencia", "normalizedHint": "VALENCIA" }
  ],
  "timeFilters": {},
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": false,
  "domain": "stock"
}

Pregunta: "matriculaciones de SUV en el primer trimestre de 2024 en Cataluña"
{
  "reasoning": "Matriculaciones de segmento SUV para una región y un trimestre",
  "primaryMetrics": ["matriculaciones"],
  "entities": [
    { "type": "segment", "rawValue": "SUV", "normalizedHint": "SUV" },
    { "type": "location", "rawValue": "Cataluña", "normalizedHint": "CATALUÑA" },
    { "type": "temporal", "rawValue": "primer trimestre", "normalizedHint": "Q1" }
  ],
  "timeFilters": { "year": "2024" },
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": false,
  "domain": "vehicle_registration"
}

Pregunta: "cuántos coches eléctricos se matricularon en Madrid en 2024"
{
  "reasoning": "Eléctrico es un tipo de combustible/fuente de energía, NO un segmento. Se filtra por fuel, no por segmento.",
  "primaryMetrics": ["matriculaciones"],
  "entities": [
    { "type": "fuel", "rawValue": "coches eléctricos", "normalizedHint": "Electrico" },
    { "type": "location", "rawValue": "Madrid", "normalizedHint": "MADRID" }
  ],
  "timeFilters": { "year": "2024" },
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": false,
  "domain": "vehicle_registration"
}

Pregunta: "cuántos híbridos se vendieron en España en 2023"
{
  "reasoning": "Híbrido es un tipo de propulsión (combustible), no un segmento de vehículo.",
  "primaryMetrics": ["matriculaciones"],
  "entities": [
    { "type": "fuel", "rawValue": "híbridos", "normalizedHint": "Híbrido" },
    { "type": "location", "rawValue": "España", "normalizedHint": "ESPAÑA" }
  ],
  "timeFilters": { "year": "2023" },
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": false,
  "domain": "vehicle_registration"
}

Pregunta: "que me puedes decir sobre el cubo de matriculaciones"
{
  "reasoning": "El usuario pregunta sobre la información disponible en el cubo de matriculaciones específicamente.",
  "primaryMetrics": [],
  "entities": [],
  "timeFilters": {},
  "preferredCube": "Matriculaciones",
  "isFollowUp": false,
  "isMetaQuestion": true,
  "domain": "vehicle_registration"
}

Pregunta: "qué datos tiene el cubo de Nissan"
{
  "reasoning": "Pregunta meta sobre el cubo de Nissan — qué medidas y dimensiones contiene.",
  "primaryMetrics": [],
  "entities": [],
  "timeFilters": {},
  "preferredCube": "Nissan",
  "isFollowUp": false,
  "isMetaQuestion": true,
  "domain": "vehicle_registration"
}

Pregunta: "qué cubos tengo disponibles"
{
  "reasoning": "El usuario pregunta qué cubos tiene accesibles, sin mencionar uno en concreto.",
  "primaryMetrics": [],
  "entities": [],
  "timeFilters": {},
  "preferredCube": null,
  "isFollowUp": false,
  "isMetaQuestion": true,
  "domain": "general"
}
=== FIN DE EJEMPLOS ===
`;

// -- Agent function -------------------------------------------------------------

export async function analyze(
  question: string,
  conversationHistory: ConversationTurn[] = [],
  visibleCubeNames: string[] = []
): Promise<QueryIntent> {
  const recentHistory = conversationHistory.slice(-4);
  let historyBlock = "";
  if (recentHistory.length > 0) {
    historyBlock = "\n\n=== HISTORIAL DE CONVERSACIÓN (para detectar seguimientos) ===\n" +
      recentHistory.map((t) =>
        `${t.role === "user" ? "Usuario" : "Asistente"}: ${t.content.slice(0, 250)}`
      ).join("\n") + "\n=============================================================";
  }

  // Bloque dinámico con los cubos reales del usuario — fundamental para preferredCube
  const cubeBlock = visibleCubeNames.length > 0
    ? `\n=== CUBOS DE DATOS ACCESIBLES POR ESTE USUARIO ===\n` +
      `Solo estos cubos están disponibles para este usuario. Si el usuario menciona uno de ellos\n` +
      `(por nombre o descripción), úsalo como preferredCube. No inventes cubos que no estén aquí.\n` +
      visibleCubeNames.map((n, i) => `  ${i + 1}. "${n}"`).join("\n") +
      `\n===================================================\n`
    : "";

  const userMessage = `${getCurrentDateContext()}

${buildJargonContextBlock()}
${cubeBlock}
${EXAMPLES}

Extrae la intención de esta pregunta:
"${question}"${historyBlock}

Responde SOLO con el JSON, sin texto adicional:`;

  console.log(`[Agent1:Intérprete] agente=${env.azurePlannerAgentId} — "${question.slice(0, 80)}"`);

  const raw = await callAgent(
    env.azurePlannerAgentId,
    INTERPRETER_INSTRUCTIONS,
    userMessage
  );

  let intent: QueryIntent;
  try {
    // Strip any markdown fence if present
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    intent = JSON.parse(jsonStr) as QueryIntent;
  } catch {
    console.error("[Agent1:Intérprete] JSON inválido:", raw.slice(0, 200));
    intent = {
      reasoning: question,
      primaryMetrics: [],
      entities: [],
      timeFilters: {},
      isFollowUp: false,
      isMetaQuestion: false,
      domain: "general"
    };
  }

  // Safety guards
  intent.primaryMetrics = Array.isArray(intent.primaryMetrics) ? intent.primaryMetrics : [];
  intent.entities       = Array.isArray(intent.entities)       ? intent.entities       : [];
  intent.timeFilters    = intent.timeFilters ?? {};

  console.log(`[Agent1:Intérprete] ->`, {
    domain:       intent.domain,
    metrics:      intent.primaryMetrics,
    entities:     intent.entities.map((e) => `${e.type}:${e.rawValue}`),
    time:         intent.timeFilters,
    followUp:     intent.isFollowUp,
    meta:         intent.isMetaQuestion,
    preferredCube: intent.preferredCube ?? null
  });

  return intent;
}
