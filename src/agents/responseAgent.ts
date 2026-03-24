/**
 * AGENTE 3 — REDACTOR DE RESPUESTAS
 *
 * Identidad profesional: Analista de negocio senior que comunica datos a ejecutivos.
 * No sabe de SSAS. No sabe de MDX. No sabe de cubos OLAP. No sabe de SQL.
 * Su único universo: datos de negocio ya calculados y lenguaje claro en español.
 *
 * Input:  pregunta original + tabla de resultados + contexto de filtros
 * Output: respuesta en texto natural, directa, honesta y sin jerga técnica
 */

import { callAgent } from "../services/agentRegistry";
import { env } from "../config/env";

// -- Types ---------------------------------------------------------------------

export type SsasResult = {
  measure_name: string;
  value: string | number;
  dimensions?: Record<string, string>;
};

export type AppliedFilter = {
  friendly_name: string;
  values: string[];
};

export type UnresolvedFilter = {
  friendly_name: string;
  values: string[];
};

export type FilterExpansion = {
  original: string;      // "SUV", "motos"
  expanded: string[];    // ["ASUV","BSUV",...] / ["Moto Carretera",...]
  friendly_name: string; // nombre de la dimensión
};

export type ResponseContext = {
  originalQuestion: string;
  cubeName: string;
  results: SsasResult[];
  appliedFilters: AppliedFilter[];
  unresolvedFilters: UnresolvedFilter[];
  filterExpansions?: FilterExpansion[];
};

// -- System prompt -------------------------------------------------------------

export const RESPONSE_INSTRUCTIONS = `
Eres un ANALISTA DE NEGOCIO SENIOR con profundo conocimiento del sector de automoción español.
Tu trabajo es responder preguntas sobre datos del mercado de forma conversacional, clara y útil.
Piensa como un experto que no solo da el número sino que lo pone en contexto y ayuda a entender qué significa.

NO menciones bases de datos, cubos, SSAS, MDX, SQL ni ningún término técnico.
Si tienes datos, los presentas con contexto. Si no los tienes, lo dices honestamente.

============================================================
 TU PERSONALIDAD Y ESTILO
============================================================

Eres conversador, útil y dinámico. Como un buen analista que habla con su director:
  - Das el dato, pero también explicas qué significa o qué implica si tienes contexto para ello.
  - Si el resultado es notable (muy alto, muy bajo, crecimiento interesante), lo comentas.
  - Si hay múltiples datos, buscas el hilo conductor: ¿qué historia cuentan juntos?
  - Puedes hacer comparaciones obvias si están en los datos (ej: si hay Madrid y Barcelona, di cuál lidera).
  - Propones seguimientos relevantes cuando tiene sentido: "¿Quieres ver esto por provincia?" o
    "¿Te interesa comparar con el año anterior?", pero SOLO si es genuinamente útil y no siempre.
  - Adapta la longitud al tipo de pregunta: una pregunta simple merece una respuesta corta;
    una pregunta compleja o con muchos datos merece más desarrollo.

============================================================
 NÚMEROS Y FORMATO
============================================================
  - Siempre en formato español: puntos para miles, coma para decimales.
    2500 -> 2.500    150000 -> 150.000    3.14 -> 3,14    0.0099 -> 0,99%
  - Si un valor es 0, di "0" — no digas "sin datos" si el sistema lo calculó.
  - Si el valor es null o vacío, di que no hay datos disponibles para ese filtro.
  - Los porcentajes con 2 decimales máximo.
  - Grandes cifras: menciona si son miles, millones, etc. para facilitar la lectura.

============================================================
 ESTRUCTURA DINÁMICA DE LA RESPUESTA
============================================================

DATO ÚNICO (una métrica, un valor):
  -> NUNCA respondas SOLO con "El valor X es Y.". Siempre añade algo de contexto, interpretación
    o una pregunta de seguimiento relevante. Al menos 2-3 frases.
  Ejemplo: "En 2024, el mercado total de automoción en España registró 1.430.130 matriculaciones
  según datos DGT. Es una cifra sólida que refleja la recuperación del sector tras los años de escasez
  de semiconductores. ¿Quieres ver cómo se distribuye por regiones o compararlo con años anteriores?"

MÚLTIPLES MÉTRICAS (varias medidas del mismo período):
  -> Presenta cada dato, luego un párrafo de síntesis que relacione los números.
  -> Busca la "historia" detrás de los números: relaciones entre métricas, qué implican juntas.
  Ejemplo: "En 2024, Nissan matriculó 34.690 vehículos sobre un mercado total de 1.430.130 unidades,
  lo que se traduce en una cuota del 2,42%. En términos prácticos, de cada 100 coches vendidos en
  España, algo más de 2 llevan el logo de Nissan."

MÚLTIPLES FILAS (varias provincias, segmentos, etc.):
  -> NO hagas una lista mecánica. Construye un relato: quién lidera, quién sorprende, qué patrón hay.
  -> Si hay más de 8 filas, destaca los 3-4 más relevantes y menciona el total.
  Ejemplo: "Madrid y Barcelona acaparan casi la mitad del volumen nacional. Valencia y Sevilla les siguen
  a distancia. Lo que llama la atención es Zaragoza, que con su base industrial mantiene cifras
  superiores a lo esperado por su tamaño poblacional."

COMPARACIÓN TEMPORAL:
  -> Si hay datos de dos períodos, calcula la variación y coméntala con perspectiva de negocio.
  -> ¿Es un buen resultado? ¿Qué lo explica (si lo sabes)?
  Ejemplo: "Pasó de 46.663 en 2024 a 57.958 en 2025, un crecimiento del 24% aproximadamente.
  Para Nissan, ese ritmo de crecimiento supera la media del mercado, lo que significa que ganó
  cuota durante el año."

============================================================
 EXPANSIÓN DE TÉRMINOS
============================================================
  - Si recibes una nota de EXPANSIÓN como "SUV -> ASUV, BSUV, BSUV+, CSUV..."
    significa que el término fue encontrado en varias subcategorías.
  - Preséntalo agrupado y destaca cuál es el segmento dominante.
  - NUNCA digas que un término expandido no fue encontrado si hay expansión confirmada.

============================================================
 FILTROS NO APLICADOS
============================================================
  - Solo si hay [WARN] FILTROS NO APLICADOS, menciónalo con honestidad.
  - Propón alternativa si tiene sentido: "No pude filtrar por ese término exacto —
    ¿quizás te refieres a [alternativa]?"

============================================================
 LO QUE NUNCA DEBES HACER
============================================================
× Mencionar "cubo", "SSAS", "MDX", "jerarquía", "base de datos", "catálogo".
× Inventar datos o cifras que no estén en los resultados recibidos.
× Hacer cálculos complejos que no estén ya calculados (puedes hacer sumas simples o estimar porcentajes obvios).
× Usar frases vacías como "¡Claro que sí!", "¡Por supuesto!", "¡Excelente pregunta!".
× Repetir la pregunta del usuario al inicio de tu respuesta.
× Dar una sola frase cuando hay contexto valioso que añadir. El mínimo útil son 2-3 frases.
× Ser excesivamente largo cuando la respuesta es sencilla (máximo 4-5 frases para preguntas directas).
× NUNCA uses etiquetas HTML (<p>, <ul>, <li>, <b>, <br>, <div>, etc.). Solo texto plano.
× No uses markdown con ** o ## para resaltar texto. Solo texto plano con puntuación normal.
`.trim();

// -- Agent function -------------------------------------------------------------

export async function generate(ctx: ResponseContext): Promise<string> {
  if (ctx.results.length === 0) {
    return buildEmptyResponse(ctx);
  }

  const userMessage = buildUserMessage(ctx);

  console.log(`[Agent3:Redactor] agente=${env.azureWorkerAgentId}`);

  // Dos intentos — el segundo usa un prompt más corto si el primero falla
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callAgent(
        env.azureWorkerAgentId,
        RESPONSE_INSTRUCTIONS,
        attempt === 1 ? userMessage : buildCompactMessage(ctx)
      );
      if (response && response.trim().length > 30) {
        return sanitizeResponse(response.trim());
      }
      console.warn(`[Agent3:Redactor] intento ${attempt}: respuesta vacía o muy corta`);
    } catch (err) {
      console.error(`[Agent3:Redactor] intento ${attempt} error:`, (err as Error).message);
      if (attempt === 2) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Fallback conversacional — nunca bullet points
  console.warn("[Agent3:Redactor] usando fallback conversacional");
  return buildFallbackResponse(ctx);
}

/** Elimina HTML y markdown que el LLM a veces genera aunque no se lo pidamos */
function sanitizeResponse(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")           // eliminar etiquetas HTML
    .replace(/\*\*(.*?)\*\*/g, "$1")   // eliminar **negrita**
    .replace(/__(.*?)__/g, "$1")       // eliminar __negrita__
    .replace(/#{1,6}\s/g, "")          // eliminar ## headers
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")        // máximo 2 saltos de línea seguidos
    .trim();
}

// -- Builders --------------------------------------------------------------------

/** Detecta si un nombre de medida representa un porcentaje/ratio */
function isPercentageMeasure(measureName: string): boolean {
  const n = measureName.toLowerCase();
  return (
    n.includes("cuota") || n.includes("share") || n.includes("%") ||
    n.includes("porcentaje") || n.includes("ratio") || n.includes("tasa") ||
    n.includes("cumplimiento") || n.includes("penetracion") ||
    n.includes("participacion") || n.includes("achievement")
  );
}

/** Convierte valor numérico a porcentaje si la medida lo requiere */
function smartFormatValue(value: string | number, measureName: string): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);

  if (isPercentageMeasure(measureName)) {
    // Los valores de cuota en SSAS suelen venir como fracción decimal (ej: 0.0237 = 2.37%)
    // Si el valor está entre 0 y 1, lo convertimos a porcentaje
    const pct = num < 1 && num > -1 ? num * 100 : num;
    return `${pct.toFixed(2).replace(".", ",")}%`;
  }

  return num.toLocaleString("es-ES");
}

function buildUserMessage(ctx: ResponseContext): string {
  const lines: string[] = [];

  lines.push(`Pregunta del usuario: "${ctx.originalQuestion}"`);

  // Hint de tipos de medida para el agente
  const percentageMeasures = ctx.results
    .map((r) => r.measure_name)
    .filter(isPercentageMeasure);
  if (percentageMeasures.length > 0) {
    lines.push(`NOTA: Las siguientes medidas son porcentajes (formatea como XX,XX%): ${[...new Set(percentageMeasures)].join(", ")}`);
  }

  // Applied filters summary
  if (ctx.appliedFilters.length > 0) {
    const filterDesc = ctx.appliedFilters
      .map((f) => `${f.friendly_name}: ${f.values.join(", ")}`)
      .join(" | ");
    lines.push(`Filtros aplicados: ${filterDesc}`);
  }

  // Results table — usar smartFormatValue para valores de porcentaje
  lines.push("");
  if (ctx.results.length <= 30) {
    lines.push("Datos obtenidos:");
    for (const row of ctx.results) {
      const dimParts = Object.entries(row.dimensions ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      const dimStr = dimParts ? `  [${dimParts}]` : "";
      lines.push(`  ${row.measure_name}: ${smartFormatValue(row.value, row.measure_name)}${dimStr}`);
    }
  } else {
    lines.push(`Datos obtenidos (${ctx.results.length} registros — mostrando los primeros 20):`);
    for (const row of ctx.results.slice(0, 20)) {
      const dimParts = Object.entries(row.dimensions ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
      lines.push(`  ${row.measure_name}: ${smartFormatValue(row.value, row.measure_name)}${dimParts ? "  [" + dimParts + "]" : ""}`);
    }
    lines.push(`  ... y ${ctx.results.length - 20} registros más.`);
  }

  // Filter expansions — tell the agent what generic terms were expanded
  if (ctx.filterExpansions && ctx.filterExpansions.length > 0) {
    lines.push("");
    lines.push("EXPANSIONES REALIZADAS (términos genéricos resueltos a categorías reales):");
    for (const e of ctx.filterExpansions) {
      lines.push(`  - "${e.original}" (${e.friendly_name}) -> ${e.expanded.join(", ")}`);
    }
    lines.push("  ↑ Estos filtros SÍ fueron aplicados. Los datos de arriba son correctos.");
  }

  // Unresolved filters — make explicit
  if (ctx.unresolvedFilters.length > 0) {
    lines.push("");
    lines.push("[WARN] FILTROS NO APLICADOS (informa al usuario de estos — no tienen datos):");
    for (const f of ctx.unresolvedFilters) {
      lines.push(`  - ${f.friendly_name || "Filtro"}: ${f.values.join(", ")}`);
    }
  }

  lines.push("");
  lines.push(
    "Escribe una respuesta EN ESPAÑOL, conversacional y analítica. " +
    "OBLIGATORIO: incluye al menos el dato principal + una interpretación/contexto + " +
    "(si es genuinamente útil) una sugerencia de seguimiento. " +
    "NUNCA respondas con una sola frase. Mínimo 2-3 frases bien conectadas. " +
    "Actúa como un analista de negocio experto que habla con su director, no como un buscador."
  );

  return lines.join("\n");
}

function buildEmptyResponse(ctx: ResponseContext): string {
  const filterDesc = ctx.appliedFilters
    .map((f) => `${f.friendly_name}: ${f.values.join(", ")}`)
    .join("; ");

  const unresolvedNote = ctx.unresolvedFilters.length > 0
    ? ` Los siguientes filtros no se pudieron aplicar: ${ctx.unresolvedFilters.flatMap((f) => f.values).join(", ")}.`
    : "";

  return [
    `No se encontraron datos para tu consulta.`,
    filterDesc ? `Filtros buscados: ${filterDesc}.` : "",
    unresolvedNote,
    "Verifica que los valores de los filtros son correctos o amplía los criterios de búsqueda."
  ].filter(Boolean).join(" ");
}

/** Fallback conversacional — nunca usa bullet points, construye frases naturales */
function buildFallbackResponse(ctx: ResponseContext): string {
  if (!ctx.results.length) return buildEmptyResponse(ctx);

  const filterDesc = ctx.appliedFilters
    .map((f) => `${f.friendly_name}: ${f.values.join(", ")}`)
    .join("; ");

  const parts: string[] = [];

  if (ctx.results.length === 1) {
    const r = ctx.results[0];
    const val = smartFormatValue(r.value, r.measure_name);
    const dimParts = Object.entries(r.dimensions ?? {})
      .map(([, v]) => v)
      .join(", ");
    parts.push(
      `El valor de ${r.measure_name} es ${val}` +
      (dimParts ? ` para ${dimParts}` : "") +
      (filterDesc ? ` (filtros: ${filterDesc})` : "") +
      "."
    );
  } else if (ctx.results.length <= 6) {
    const intro = filterDesc
      ? `Con los filtros aplicados (${filterDesc}), los datos son:`
      : "Los datos obtenidos son:";
    parts.push(intro);
    for (const r of ctx.results) {
      const val = smartFormatValue(r.value, r.measure_name);
      const dimParts = Object.entries(r.dimensions ?? {}).map(([, v]) => v).join(", ");
      parts.push(`${r.measure_name}: ${val}${dimParts ? ` (${dimParts})` : ""}.`);
    }
  } else {
    const intro = filterDesc
      ? `Con los filtros aplicados (${filterDesc}), se encontraron ${ctx.results.length} registros. Los más relevantes:`
      : `Se encontraron ${ctx.results.length} registros. Los más relevantes:`;
    parts.push(intro);
    for (const r of ctx.results.slice(0, 5)) {
      const val = smartFormatValue(r.value, r.measure_name);
      const dimParts = Object.entries(r.dimensions ?? {}).map(([, v]) => v).join(", ");
      parts.push(`${r.measure_name}: ${val}${dimParts ? ` (${dimParts})` : ""}.`);
    }
    if (ctx.results.length > 5) {
      parts.push(`Hay ${ctx.results.length - 5} registros adicionales.`);
    }
  }

  if (ctx.unresolvedFilters.length > 0) {
    const unresolved = ctx.unresolvedFilters.flatMap((f) => f.values).join(", ");
    parts.push(`Nota: no se encontraron datos para: ${unresolved}.`);
  }

  return parts.join(" ");
}

/** Mensaje compacto para el segundo intento (en caso de que el primero falle por tokens) */
function buildCompactMessage(ctx: ResponseContext): string {
  const r = ctx.results.slice(0, 5);
  const data = r.map((row) => {
    const val = smartFormatValue(row.value, row.measure_name);
    const dims = Object.values(row.dimensions ?? {}).join(", ");
    return `${row.measure_name}: ${val}${dims ? ` (${dims})` : ""}`;
  }).join(". ");
  const filters = ctx.appliedFilters.map((f) => `${f.friendly_name}=${f.values.join(",")}`).join("; ");
  return `Pregunta: "${ctx.originalQuestion}". Datos: ${data}. ${filters ? "Filtros: " + filters + "." : ""} Responde de forma conversacional y natural en español.`;
}
