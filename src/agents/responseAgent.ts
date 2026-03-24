/**
 * AGENTE 3 — REDACTOR DE RESPUESTAS
 *
 * Identidad profesional: Analista de negocio senior que comunica datos a ejecutivos.
 * No sabe de SSAS. No sabe de MDX. No sabe de cubos OLAP. No sabe de SQL.
 * Su único universo: datos de negocio ya calculados y lenguaje claro en español.
 *
 * Input:  pregunta original + tabla de resultados + contexto de filtros + agregados calculados
 * Output: { answer: texto plano, answer_html: HTML semántico o null }
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
  original: string;
  expanded: string[];
  friendly_name: string;
};

export type ComputedAggregations = {
  sum: number | null;
  avg: number | null;
  max: number | null;
  min: number | null;
  count: number;
  label: string;
};

export type ResponseContext = {
  originalQuestion: string;
  cubeName: string;
  results: SsasResult[];
  appliedFilters: AppliedFilter[];
  unresolvedFilters: UnresolvedFilter[];
  filterExpansions?: FilterExpansion[];
  computed?: ComputedAggregations | null;
};

export type GenerateResult = {
  answer: string;
  answer_html: string | null;
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
  - Propones seguimientos relevantes cuando tiene sentido, pero SOLO si es genuinamente útil y no siempre.
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
 FORMATO HTML DE LA RESPUESTA
============================================================

Usa HTML semántico SOLO cuando el contenido lo justifica. Reglas estrictas:

DATO ÚNICO (una métrica, un valor):
  -> Responde en texto plano. Sin etiquetas HTML. Mínimo 2-3 frases con contexto.

LISTA DE ITEMS (3 o más items sin relación numérica directa):
  -> Usa <ul><li>item</li></ul>
  -> Añade un párrafo de texto ANTES de la lista a modo de introducción.
  -> Los números clave dentro del texto de cada <li> puedes envolverlos en <strong>.

COMPARATIVA CON VALORES NUMÉRICOS (2+ filas con etiqueta + número):
  -> Usa una tabla: <table><thead><tr><th>Etiqueta</th><th>Valor</th></tr></thead><tbody>...</tbody></table>
  -> Siempre incluye un párrafo de análisis DESPUÉS de la tabla.
  -> Los valores más destacados dentro de <td> puedes envolverlos en <strong>.

RESPUESTA MIXTA (texto + tabla o texto + lista):
  -> El texto y la estructura HTML se mezclan naturalmente. Escribe el análisis y luego muestra los datos estructurados (o al revés si tiene más sentido).

Tags PERMITIDOS: ul, ol, li, table, thead, tbody, tr, th, td, strong, em, br, p
Tags PROHIBIDOS: div, span, script, style, a, img, input, form, cualquier atributo on*, href, src, style.

============================================================
 ESTRUCTURA DINÁMICA DE LA RESPUESTA
============================================================

MÚLTIPLES MÉTRICAS (varias medidas del mismo período):
  -> Presenta cada dato en tabla, luego un párrafo de síntesis.

MÚLTIPLES FILAS (varias provincias, segmentos, etc.):
  -> Tabla con los datos, más análisis de quién lidera y qué patrón hay.
  -> Si hay totales calculados (TOTALES CALCULADOS en el contexto), menciónalos.

COMPARACIÓN TEMPORAL:
  -> Si hay datos de dos períodos, calcula la variación y coméntala con perspectiva de negocio.

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
  - Propón alternativa si tiene sentido.

============================================================
 LO QUE NUNCA DEBES HACER
============================================================
× Mencionar "cubo", "SSAS", "MDX", "jerarquía", "base de datos", "catálogo".
× Inventar datos o cifras que no estén en los resultados recibidos.
× Hacer cálculos complejos que no estén ya calculados (puedes referenciar los TOTALES CALCULADOS que te pasen).
× Usar frases vacías como "¡Claro que sí!", "¡Por supuesto!", "¡Excelente pregunta!".
× Repetir la pregunta del usuario al inicio de tu respuesta.
× Dar una sola frase cuando hay contexto valioso que añadir. El mínimo útil son 2-3 frases.
× Ser excesivamente largo cuando la respuesta es sencilla (máximo 4-5 frases para preguntas directas).
× Usar etiquetas HTML que no estén en la lista de permitidos.
× No uses markdown con ** o ## para resaltar texto. Usa <strong> cuando el HTML sea apropiado.
`.trim();

// -- HTML allowlist sanitizer --------------------------------------------------

const ALLOWED_HTML_TAGS = new Set([
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "strong", "em", "b", "i", "br", "p"
]);

const DANGEROUS_ATTRS = /\s+(on\w+|href|src|style|class|id|data-[^=\s]*)\s*=\s*["'][^"']*["']/gi;

/**
 * Sanitiza HTML eliminando tags no permitidos y atributos peligrosos.
 * No usa un parser DOM completo para evitar dependencias externas.
 * La validación final la hace el frontend (DOMPurify recomendado).
 */
function sanitizeHtml(html: string): string {
  return html
    // Eliminar atributos peligrosos en todos los tags
    .replace(DANGEROUS_ATTRS, "")
    // Eliminar tags no en la allowlist (apertura y cierre)
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tagName: string) => {
      if (ALLOWED_HTML_TAGS.has(tagName.toLowerCase())) {
        // Reescribir el tag sin atributos para garantizar limpieza
        const isClosing = match.startsWith("</");
        const isSelfClosing = match.endsWith("/>") || tagName.toLowerCase() === "br";
        if (isClosing) return `</${tagName.toLowerCase()}>`;
        if (isSelfClosing) return `<${tagName.toLowerCase()} />`;
        return `<${tagName.toLowerCase()}>`;
      }
      // Tag no permitido: eliminarlo
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Detecta si una cadena contiene HTML semántico relevante (no solo texto plano).
 */
function containsHtml(text: string): boolean {
  return /<(ul|ol|table|strong|em|br|p)\b/i.test(text);
}

/**
 * Convierte HTML a texto plano legible.
 * Las tablas se convierten a un formato de columnas alineadas con separadores.
 * Las listas se convierten a viñetas con guión.
 */
function htmlToPlainText(html: string): string {
  // -- 1. Convertir tablas a texto tabulado ------------------------------------
  // Estrategia: extraer todas las filas y sus celdas, luego formatear con padding.
  let result = html;

  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner: string) => {
    // Extraer todas las filas
    const rowMatches = inner.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
    const tableRows: string[][] = rowMatches.map((rowHtml) => {
      // Extraer todas las celdas (th o td)
      const cellMatches = rowHtml.match(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi) ?? [];
      return cellMatches.map((cellHtml) => {
        // Limpiar tags dentro de la celda
        return cellHtml
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
          .trim();
      });
    });

    if (tableRows.length === 0) return "";

    // Calcular ancho máximo por columna
    const colCount = Math.max(...tableRows.map((r) => r.length));
    const colWidths: number[] = Array.from({ length: colCount }, (_, ci) =>
      Math.max(...tableRows.map((r) => (r[ci] ?? "").length), 4)
    );

    // Formatear filas
    const lines: string[] = [];
    tableRows.forEach((row, ri) => {
      const line = row
        .map((cell, ci) => cell.padEnd(colWidths[ci] ?? cell.length))
        .join("  |  ");
      lines.push(line);
      // Separador después del header (primera fila)
      if (ri === 0) {
        const sep = colWidths.map((w) => "-".repeat(w)).join("--+--");
        lines.push(sep);
      }
    });
    return "\n" + lines.join("\n") + "\n";
  });

  // -- 2. Convertir listas a viñetas ------------------------------------------
  result = result
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      return `\n- ${text}`;
    })
    .replace(/<\/ul>|<\/ol>/gi, "\n")
    .replace(/<ul[^>]*>|<ol[^>]*>/gi, "");

  // -- 3. Párrafos y saltos de línea ------------------------------------------
  result = result
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "$1")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "$1")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "$1")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "$1")
    .replace(/<[^>]+>/g, "")  // eliminar cualquier tag restante
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return result;
}

// -- Agent function -------------------------------------------------------------

/** Extrae el tiempo de espera en ms desde un error 429 */
function extract429WaitMs(err: unknown, attempt: number): number {
  const msg = String((err as Error)?.message ?? "");
  const retryMatch = msg.match(/retry[_-]after[:\s]+(\d+)/i);
  if (retryMatch) return Number(retryMatch[1]) * 1000 + 500;
  return [8000, 20000, 45000][Math.min(attempt - 1, 2)];
}

export async function generate(ctx: ResponseContext): Promise<GenerateResult> {
  if (ctx.results.length === 0) {
    const text = buildEmptyResponse(ctx);
    return { answer: text, answer_html: null };
  }

  const userMessage = buildUserMessage(ctx);

  console.log(`[Agent3:Redactor] agente=${env.azureWorkerAgentId} resultados=${ctx.results.length}`);

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const msg = attempt === 1 ? userMessage : buildCompactMessage(ctx);
      const response = await callAgent(env.azureWorkerAgentId, RESPONSE_INSTRUCTIONS, msg);
      if (response && response.trim().length > 30) {
        console.log(`[Agent3:Redactor] OK en intento ${attempt}`);
        const raw = response.trim();
        const hasHtml = containsHtml(raw);
        const answer_html = hasHtml ? sanitizeHtml(raw) : null;
        const answer = hasHtml ? htmlToPlainText(raw) : raw;
        return { answer, answer_html };
      }
      console.warn(`[Agent3:Redactor] intento ${attempt}: respuesta vacía o muy corta`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const is429 = msg.includes("429") || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("too many");
      console.warn(`[Agent3:Redactor] intento ${attempt}/${MAX_ATTEMPTS} ${is429 ? "[429 rate-limit]" : "[error]"}: ${msg}`);

      if (attempt < MAX_ATTEMPTS) {
        const waitMs = is429 ? extract429WaitMs(err, attempt) : 2000;
        console.log(`[Agent3:Redactor] esperando ${(waitMs / 1000).toFixed(1)}s antes del siguiente intento...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  console.warn("[Agent3:Redactor] usando fallback conversacional tras agotar reintentos");
  return buildFallbackResponse(ctx);
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
    const pct = num < 1 && num > -1 ? num * 100 : num;
    return `${pct.toFixed(2).replace(".", ",")}%`;
  }

  return num.toLocaleString("es-ES");
}

function buildUserMessage(ctx: ResponseContext): string {
  const lines: string[] = [];

  lines.push(`Pregunta del usuario: "${ctx.originalQuestion}"`);

  const percentageMeasures = ctx.results
    .map((r) => r.measure_name)
    .filter(isPercentageMeasure);
  if (percentageMeasures.length > 0) {
    lines.push(`NOTA: Las siguientes medidas son porcentajes (formatea como XX,XX%): ${[...new Set(percentageMeasures)].join(", ")}`);
  }

  if (ctx.appliedFilters.length > 0) {
    const filterDesc = ctx.appliedFilters
      .map((f) => `${f.friendly_name}: ${f.values.join(", ")}`)
      .join(" | ");
    lines.push(`Filtros aplicados: ${filterDesc}`);
  }

  // Totales calculados en Node.js (exactos)
  if (ctx.computed && ctx.computed.count > 1) {
    const c = ctx.computed;
    const parts: string[] = [`count=${c.count}`];
    if (c.sum != null) parts.push(`suma=${c.sum.toLocaleString("es-ES")}`);
    if (c.avg != null) parts.push(`promedio=${c.avg.toLocaleString("es-ES")}`);
    if (c.max != null) parts.push(`máximo=${c.max.toLocaleString("es-ES")}`);
    if (c.min != null) parts.push(`mínimo=${c.min.toLocaleString("es-ES")}`);
    lines.push(`TOTALES CALCULADOS (${c.label}): ${parts.join(", ")}`);
  }

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

  if (ctx.filterExpansions && ctx.filterExpansions.length > 0) {
    lines.push("");
    lines.push("EXPANSIONES REALIZADAS (términos genéricos resueltos a categorías reales):");
    for (const e of ctx.filterExpansions) {
      lines.push(`  - "${e.original}" (${e.friendly_name}) -> ${e.expanded.join(", ")}`);
    }
    lines.push("  Estos filtros SI fueron aplicados. Los datos de arriba son correctos.");
  }

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
    "Usa HTML semántico (tabla o lista) cuando haya 2+ datos comparables. " +
    "OBLIGATORIO: incluye al menos el dato principal + una interpretación/contexto. " +
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

/** Fallback: construye HTML simple cuando el LLM no respondió */
function buildFallbackResponse(ctx: ResponseContext): GenerateResult {
  if (!ctx.results.length) {
    const text = buildEmptyResponse(ctx);
    return { answer: text, answer_html: null };
  }

  const filterDesc = ctx.appliedFilters
    .map((f) => `${f.friendly_name}: ${f.values.join(", ")}`)
    .join("; ");

  if (ctx.results.length === 1) {
    const r = ctx.results[0];
    const val = smartFormatValue(r.value, r.measure_name);
    const dimParts = Object.entries(r.dimensions ?? {}).map(([, v]) => v).join(", ");
    const text =
      `El valor de ${r.measure_name} es ${val}` +
      (dimParts ? ` para ${dimParts}` : "") +
      (filterDesc ? ` (filtros: ${filterDesc})` : "") + ".";
    return { answer: text, answer_html: null };
  }

  // Múltiples resultados: construir tabla HTML
  const rows = ctx.results.map((r) => {
    const val = smartFormatValue(r.value, r.measure_name);
    const dimLabel = Object.values(r.dimensions ?? {}).join(", ") || r.measure_name;
    return `<tr><td>${dimLabel}</td><td><strong>${val}</strong></td></tr>`;
  }).join("");

  const computedNote = ctx.computed?.sum != null
    ? `<p><strong>Total: ${ctx.computed.sum.toLocaleString("es-ES")}</strong>${filterDesc ? ` (${filterDesc})` : ""}</p>`
    : "";

  const answer_html = `<table><thead><tr><th>Concepto</th><th>Valor</th></tr></thead><tbody>${rows}</tbody></table>${computedNote}`;
  const answer = htmlToPlainText(answer_html) + (ctx.computed?.sum != null ? ` Total: ${ctx.computed.sum.toLocaleString("es-ES")}.` : "");

  if (ctx.unresolvedFilters.length > 0) {
    const unresolved = ctx.unresolvedFilters.flatMap((f) => f.values).join(", ");
    return {
      answer: answer + ` Nota: no se encontraron datos para: ${unresolved}.`,
      answer_html: answer_html + `<p>Nota: no se encontraron datos para: ${unresolved}.</p>`
    };
  }

  return { answer, answer_html };
}

/** Mensaje compacto para el segundo intento */
function buildCompactMessage(ctx: ResponseContext): string {
  const r = ctx.results.slice(0, 5);
  const data = r.map((row) => {
    const val = smartFormatValue(row.value, row.measure_name);
    const dims = Object.values(row.dimensions ?? {}).join(", ");
    return `${row.measure_name}: ${val}${dims ? ` (${dims})` : ""}`;
  }).join(". ");
  const filters = ctx.appliedFilters.map((f) => `${f.friendly_name}=${f.values.join(",")}`).join("; ");
  const computed = ctx.computed?.sum != null ? ` Suma total: ${ctx.computed.sum.toLocaleString("es-ES")}.` : "";
  return `Pregunta: "${ctx.originalQuestion}". Datos: ${data}.${computed} ${filters ? "Filtros: " + filters + "." : ""} Responde en español con HTML semántico (tabla si hay varios datos).`;
}
