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
import { RESPONSE_MAX_DIMENSION_COLUMNS } from "../config/responseLimits";

// -- Types ---------------------------------------------------------------------

export type SsasResult = {
  measure_name: string;
  value: string | number;
  dimensions?: Record<string, string>;
  /** Fila de total de contexto en desglose (visor); se pinta en tfoot. */
  is_breakdown_total_row?: boolean;
};

export type AppliedFilter = {
  friendly_name: string;
  values: string[];
};

export type UnresolvedFilter = {
  friendly_name: string;
  values: string[];
};

/** Filtro resuelto con coincidencia no exacta (para aviso breve al usuario) */
export type LowConfidenceFilterHint = {
  friendly_name: string;
  user_value: string;
  resolved_as: string;
  /** "high" | "medium" | "low" */
  level: string;
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

/** Aviso cuando la respuesta no incluye todos los registros o dimensiones */
export type ResponseTruncation = {
  totalRowCount: number;
  shownRows: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type ResponseContext = {
  originalQuestion: string;
  cubeName: string;
  results: SsasResult[];
  appliedFilters: AppliedFilter[];
  unresolvedFilters: UnresolvedFilter[];
  filterExpansions?: FilterExpansion[];
  /** Coincidencias aproximadas en filtros (medium/low) */
  lowConfidenceFilterHints?: LowConfidenceFilterHint[];
  computed?: ComputedAggregations | null;
  /** Si hay más datos en SSAS de los que se muestran (filas / columnas de dimensión) */
  truncation?: ResponseTruncation | null;
  /** Id de cliente Launcher para reglas específicas en el prompt del redactor. */
  customerId?: string | null;
};

export type GenerateResult = {
  answer: string;
  answer_html: string | null;
};

// -- System prompt -------------------------------------------------------------

export const RESPONSE_INSTRUCTIONS = `
Eres un ANALISTA DE NEGOCIO SENIOR con profundo conocimiento del sector de automoción español.
Tu trabajo es redactar el ANÁLISIS y CONTEXTO de los datos que ya se te presentan formateados.
El sistema inserta la tabla de datos automáticamente — TÚ NUNCA debes generar tablas ni listas de datos numéricos.

NO menciones bases de datos, cubos, SSAS, MDX, SQL ni ningún término técnico.
Si tienes datos, los analizas con contexto. Si no los tienes, lo dices honestamente.

============================================================
 TU ROL EXACTO
============================================================

Recibirás los datos ya listos. Tu misión es escribir el TEXTO DE ANÁLISIS que acompaña a esos datos:
  - ¿Qué significan esos números en el contexto del sector?
  - ¿Hay alguna tendencia, anomalía o dato destacado?
  - ¿Qué comparación o conclusión se puede extraer?
  - ¿Hay algo que el director deba saber más allá del número bruto?

============================================================
 PERSONALIDAD Y ESTILO
============================================================

Conversador, útil y directo. Como un analista que habla con su director:
  - Comentas lo notable (muy alto, muy bajo, crecimiento, caída inesperada).
  - Buscas el hilo conductor si hay varios datos.
  - Propones un seguimiento SOLO si es genuinamente útil, no siempre.
  - Pregunta simple → respuesta corta (2-3 frases). Pregunta compleja → más desarrollo.

============================================================
 NÚMEROS EN TU TEXTO
============================================================
  - Formato español: puntos para miles, coma para decimales.
    150000 -> 150.000    3.14 -> 3,14    0.099 -> 9,9%
  - Los porcentajes con máximo 2 decimales.
  - Grandes cifras: menciona si son miles, millones, etc.

============================================================
 FORMATO DE TU RESPUESTA
============================================================

Tu respuesta es SOLO TEXTO DE ANÁLISIS. No uses tablas ni listas de datos.
Si quieres destacar algo, puedes usar <strong>texto clave</strong> o <em>énfasis</em>.
Si necesitas un listado cualitativo (no numérico), usa <ul><li>...</li></ul>.

Tags PERMITIDOS en tu texto: strong, em, ul, ol, li, p, br
Tags PROHIBIDOS: table, thead, tbody, tr, th, td, div, span, script, a, img.

NO uses markdown con ** o ## — usa <strong> si necesitas negrita.

============================================================
 CASO ESPECIAL: PREGUNTA SOBRE DISPONIBILIDAD DE DATOS
============================================================

Si el usuario pregunta qué datos hay disponibles, qué métricas existen, o qué puedes consultar:
  - Responde con una descripción clara de las métricas disponibles.
  - Usa <ul><li>nombre de métrica — descripción breve</li></ul> para listarlas.
  - Agrupa por categoría si hay muchas.

============================================================
 DATOS DEL SISTEMA (CRÍTICO)
============================================================
Los valores vienen del análisis tal cual: cada fila es un dato devuelto por el sistema.
× NUNCA calcules por tu cuenta sumas, totales, promedios, medias ni operaciones entre filas,
  salvo que el bloque "TOTALES CALCULADOS" aparezca explícitamente más abajo (solo entonces
  puedes citar ese total como apoyo, y solo si el usuario pidió un agregado).
× Si hay texto o unidades mezcladas con números en una celda, trata el valor como dato literal;
  no lo conviertas ni lo combines con otros.
× No interpretes un listado como "el total es X" sumando filas: describe lo que muestra cada fila.

============================================================
 LO QUE NUNCA DEBES HACER
============================================================
× Generar una tabla con datos numéricos (el sistema lo hace automáticamente).
× Mencionar "cubo", "SSAS", "MDX", "jerarquía", "base de datos", "catálogo".
× Inventar datos o cifras que no estén en los resultados recibidos.
× Usar frases vacías como "¡Claro que sí!", "¡Por supuesto!", "¡Excelente pregunta!".
× Repetir la pregunta del usuario al inicio de tu respuesta.
× Responder con una sola frase cuando hay contexto valioso que añadir (mínimo 2-3 frases).
× Ser excesivamente largo para preguntas simples (máximo 4-5 frases).
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
 * Detecta si una cadena contiene HTML semántico estructural (tablas, listas, párrafos).
 */
function containsHtml(text: string): boolean {
  return /<(ul|ol|table|strong|em|p)\b/i.test(text);
}

/**
 * Convierte texto plano a HTML básico: párrafos separados por línea en blanco,
 * saltos de línea simples como <br>. Garantiza que answer_html nunca sea null.
 */
function plainTextToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br>").trim()}</p>`)
    .filter((p) => p !== "<p></p>")
    .join("\n");
}

/** Detecta si una línea parece fila de tabla Markdown (tiene al menos un |) */
function isPipeRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && !t.startsWith("<");
}

/** Detecta si una línea es la fila separadora de una tabla Markdown (---|---) */
function isSeparatorRow(line: string): boolean {
  return /^[\s|\-:]+$/.test(line.trim()) && line.includes("-") && line.includes("|");
}

/** Parsea las celdas de una fila Markdown eliminando pipes vacíos de los extremos */
function parsePipeCells(row: string): string[] {
  return row
    .split("|")
    .map((c) => c.trim())
    .filter((c, i, arr) => !(i === 0 && c === "") && !(i === arr.length - 1 && c === ""));
}

/** Construye un <table> HTML a partir de filas de datos (sin separadores) */
function buildHtmlTableFromRows(dataRows: string[]): string {
  if (dataRows.length < 2) return dataRows.join("\n");
  const [headerRow, ...bodyRows] = dataRows;
  const headers = parsePipeCells(headerRow);
  if (headers.length < 2) return dataRows.join("\n");
  const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const tbody = bodyRows.length > 0
    ? `<tbody>${bodyRows
        .map((row) => {
          const cells = parsePipeCells(row);
          return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
        })
        .join("")}</tbody>`
    : "";
  return `<table>${thead}${tbody}</table>`;
}

/**
 * Pre-procesa la respuesta del LLM antes de sanitizarla:
 * 1. Normaliza <br> de vuelta a saltos de línea
 * 2. Convierte tablas Markdown (pipe format) a <table> HTML
 */
function preprocessLlmResponse(raw: string): string {
  // Normalizar <br> para poder procesar línea a línea
  let text = raw.replace(/<br\s*\/?>/gi, "\n");

  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isPipeRow(lines[i]) && !isSeparatorRow(lines[i])) {
      // Recoger todas las filas de la tabla (pipe rows + separator rows)
      const tableLines: string[] = [];
      while (i < lines.length && (isPipeRow(lines[i]) || isSeparatorRow(lines[i]))) {
        tableLines.push(lines[i]);
        i++;
      }
      // Separar filas de datos (sin las separadoras ---)
      const dataRows = tableLines.filter((l) => !isSeparatorRow(l));
      if (dataRows.length >= 2) {
        output.push(buildHtmlTableFromRows(dataRows));
      } else {
        output.push(...tableLines);
      }
    } else {
      output.push(lines[i]);
      i++;
    }
  }

  return output.join("\n");
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

// -- Backend-driven HTML builders ---------------------------------------------

/**
 * Construye una <table> HTML directamente desde ctx.results.
 * El backend siempre es la fuente de verdad para la estructura de datos.
 * Devuelve null si hay 0 o 1 resultado (no se necesita tabla).
 */
function buildResultsTableHtml(ctx: ResponseContext): string | null {
  const rows = ctx.results.filter((r) => r.value !== null && r.value !== undefined);
  if (rows.length < 2) return null;

  const detailRows = rows.filter((r) => !r.is_breakdown_total_row);
  const totalRows = rows.filter((r) => r.is_breakdown_total_row);

  const measureNames = [...new Set(detailRows.map((r) => r.measure_name))];
  const hasMultipleMeasures = measureNames.length > 1;
  const hasDimensions = detailRows.some((r) => Object.keys(r.dimensions ?? {}).length > 0);

  // Determinar la dimensión principal (primera clave de dimensions)
  const firstDimKey = Object.keys(
    detailRows.find((r) => r.dimensions && Object.keys(r.dimensions).length > 0)?.dimensions ?? {}
  )[0];

  let headerRow: string;
  if (hasMultipleMeasures && hasDimensions) {
    headerRow = `<tr><th>Métrica</th><th>${firstDimKey ?? "Categoría"}</th><th>Valor</th></tr>`;
  } else if (hasMultipleMeasures) {
    headerRow = `<tr><th>Métrica</th><th>Valor</th></tr>`;
  } else {
    headerRow = `<tr><th>${firstDimKey ?? "Categoría"}</th><th>${measureNames[0] ?? "Valor"}</th></tr>`;
  }

  const bodyRows = detailRows.map((r) => {
    const val = `<strong>${smartFormatValue(r.value, r.measure_name)}</strong>`;
    const dimVal = Object.values(r.dimensions ?? {}).join(", ") || "—";

    if (hasMultipleMeasures && hasDimensions) {
      return `<tr><td>${r.measure_name}</td><td>${dimVal}</td><td>${val}</td></tr>`;
    } else if (hasMultipleMeasures) {
      return `<tr><td>${r.measure_name}</td><td>${val}</td></tr>`;
    } else {
      return `<tr><td>${dimVal}</td><td>${val}</td></tr>`;
    }
  }).join("");

  const footerRows =
    totalRows.length > 0
      ? `<tfoot>${totalRows
          .map((r) => {
            const val = `<strong>${smartFormatValue(r.value, r.measure_name)}</strong>`;
            const dimVal = Object.values(r.dimensions ?? {}).join(", ") || "—";
            if (hasMultipleMeasures && hasDimensions) {
              return `<tr class="breakdown-total-row"><td>${r.measure_name}</td><td>${dimVal}</td><td>${val}</td></tr>`;
            }
            if (hasMultipleMeasures) {
              return `<tr class="breakdown-total-row"><td>${r.measure_name}</td><td>${val}</td></tr>`;
            }
            return `<tr class="breakdown-total-row"><td>${dimVal}</td><td>${val}</td></tr>`;
          })
          .join("")}</tfoot>`
      : "";

  // Nota de totales calculados al pie de la tabla
  let footer = "";
  if (ctx.computed && ctx.computed.count > 1 && ctx.computed.sum !== null) {
    const c = ctx.computed;
    const parts: string[] = [];
    if (c.sum !== null) parts.push(`Total (solicitado): <strong>${c.sum.toLocaleString("es-ES")}</strong>`);
    if (c.avg !== null) parts.push(`Promedio: ${c.avg.toLocaleString("es-ES")}`);
    footer = `<p class="table-summary">${parts.join(" &nbsp;|&nbsp; ")}</p>`;
  }

  const t = ctx.truncation;
  let cap = "";
  if (t && (t.truncatedRows || t.truncatedColumns)) {
    const parts: string[] = [];
    if (t.truncatedRows) {
      parts.push(
        `Mostrando <strong>${t.shownRows}</strong> de <strong>${t.totalRowCount.toLocaleString("es-ES")}</strong> filas`
      );
    }
    if (t.truncatedColumns) {
      parts.push(
        `máximo <strong>${RESPONSE_MAX_DIMENSION_COLUMNS}</strong> columnas de dimensión por fila`
      );
    }
    cap = `<p class="response-truncation-notice">${parts.join(". ")}.</p>`;
  }

  return `${cap}<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody>${footerRows}</table>${footer}`;
}

/**
 * Elimina cualquier tabla que el LLM haya generado en su respuesta.
 * El backend construye las tablas desde los datos estructurados.
 */
function stripLlmTables(text: string): string {
  // Eliminar <table>...</table>
  let result = text.replace(/<table[\s\S]*?<\/table>/gi, "").trim();
  // Eliminar tablas Markdown pipe (líneas con |)
  result = result
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // Excluir líneas que sean filas de tabla (tienen |) y líneas separadoras (---)
      if (/^[\s|:\-]+$/.test(t) && t.includes("-")) return false;
      if (t.includes("|") && !t.startsWith("<") && t.split("|").length > 2) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return result;
}

/**
 * Convierte listas de items en texto plano (separadas por comas, punto y coma
 * o saltos de línea) a <ul><li> cuando detecta una enumeración larga (5+ items).
 * Útil para meta-preguntas como "qué métricas hay disponibles".
 */
function autoListify(text: string): string {
  // Si ya tiene <ul> o <li>, no tocar
  if (/<ul|<li/i.test(text)) return text;

  // Detectar párrafos que son enumeraciones: 5+ items separados por coma/punto y coma
  return text.replace(/(<p>|^)(([^<\n]{3,60}[,;]\s*){4,}[^<\n]{3,60})(<\/p>|$)/gm, (match, open, content, _last, close) => {
    const items = content
      .split(/[,;]/)
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 1);
    if (items.length < 5) return match;
    const listHtml = `<ul>${items.map((i: string) => `<li>${i}</li>`).join("")}</ul>`;
    return `${open || ""}${listHtml}${close || ""}`;
  });
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
    return { answer: text, answer_html: plainTextToHtml(text) };
  }

  const userMessage = buildUserMessage(ctx);

  console.log(`[Agent3:Redactor] agente=${env.azureWorkerAgentId} resultados=${ctx.results.length}`);

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const msg = attempt === 1 ? userMessage : buildCompactMessage(ctx);
      const response = await callAgent(
        env.azureWorkerAgentId,
        RESPONSE_INSTRUCTIONS,
        msg,
        undefined,
        ctx.customerId ?? null
      );
      if (response && response.trim().length > 30) {
        console.log(`[Agent3:Redactor] OK en intento ${attempt}`);

        // 1. Pre-procesar respuesta del LLM
        const processed = preprocessLlmResponse(response.trim());

        // 2. Quitar cualquier tabla que el LLM haya generado (el backend las construye)
        const cleanedLlm = stripLlmTables(processed);

        // 3. Construir tabla HTML desde los datos estructurados (fiable, siempre bien formateada)
        const dataTable = buildResultsTableHtml(ctx);

        // 4. Preparar el análisis del LLM como HTML
        const hasHtml = containsHtml(cleanedLlm);
        let analysisHtml = hasHtml ? sanitizeHtml(cleanedLlm) : plainTextToHtml(cleanedLlm);
        analysisHtml = autoListify(analysisHtml);

        // 5. Combinar: tabla de datos + análisis del LLM
        const answer_html = [dataTable, analysisHtml].filter(Boolean).join("\n");
        const answer = [
          dataTable ? htmlToPlainText(dataTable) : null,
          hasHtml ? htmlToPlainText(cleanedLlm) : cleanedLlm
        ].filter(Boolean).join("\n\n");

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

  if (ctx.truncation && (ctx.truncation.truncatedRows || ctx.truncation.truncatedColumns)) {
    const t = ctx.truncation;
    lines.push(
      `AVISO LÍMITE DE DATOS: ${t.truncatedRows ? `solo se muestran ${t.shownRows} filas de ${t.totalRowCount} totales.` : ""}` +
        `${t.truncatedColumns ? ` Algunas filas tienen muchas dimensiones; solo se incluyen las primeras ${RESPONSE_MAX_DIMENSION_COLUMNS} columnas de dimensión.` : ""}` +
        " No digas que tienes el universo completo; puedes mencionar que la vista está limitada."
    );
  }

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

  // Totales solo si el usuario pidió suma/total y todos los valores fueron numéricos puros
  if (ctx.computed && ctx.computed.count > 1) {
    const c = ctx.computed;
    const parts: string[] = [`count=${c.count}`];
    if (c.sum != null) parts.push(`suma=${c.sum.toLocaleString("es-ES")}`);
    if (c.avg != null) parts.push(`promedio=${c.avg.toLocaleString("es-ES")}`);
    if (c.max != null) parts.push(`máximo=${c.max.toLocaleString("es-ES")}`);
    if (c.min != null) parts.push(`mínimo=${c.min.toLocaleString("es-ES")}`);
    lines.push(`TOTALES CALCULADOS (${c.label}) — el usuario pidió agregado; puedes citarlos: ${parts.join(", ")}`);
  } else {
    lines.push(
      "NO hay totales ni sumas automáticas: los números son fila a fila del sistema. " +
        "No inventes sumas ni promedios entre filas."
    );
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

  if (ctx.lowConfidenceFilterHints && ctx.lowConfidenceFilterHints.length > 0) {
    lines.push("");
    lines.push(
      "COINCIDENCIAS APROXIMADAS EN FILTROS (los datos usan la interpretación indicada; si es ambigua, dilo en una frase):"
    );
    for (const h of ctx.lowConfidenceFilterHints) {
      lines.push(
        `  - ${h.friendly_name}: "${h.user_value}" → se usó "${h.resolved_as}" (confianza ${h.level})`
      );
    }
  }

  lines.push("");
  if (ctx.results.length > 1) {
    lines.push(
      "INSTRUCCIÓN: La tabla con los datos anteriores se inserta AUTOMÁTICAMENTE en la respuesta. " +
      "NO generes ninguna tabla ni lista de datos numéricos. " +
      "Escribe SOLO el análisis/contexto en texto: qué significan los datos, tendencias, comparaciones, conclusión. " +
      "Mínimo 2-3 frases bien conectadas. Actúa como analista de negocio experto."
    );
  } else {
    lines.push(
      "Escribe una respuesta EN ESPAÑOL, conversacional y analítica. " +
      "OBLIGATORIO: incluye el dato principal + una interpretación/contexto. " +
      "NUNCA respondas con una sola frase. Mínimo 2-3 frases bien conectadas. " +
      "NO uses markdown con ** o ##. Usa <strong> si quieres resaltar algo."
    );
  }

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
    return { answer: text, answer_html: plainTextToHtml(text) };
  }

  // Múltiples resultados: construir tabla HTML
  const rows = ctx.results.map((r) => {
    const val = smartFormatValue(r.value, r.measure_name);
    const dimLabel = Object.values(r.dimensions ?? {}).join(", ") || r.measure_name;
    return `<tr><td>${dimLabel}</td><td><strong>${val}</strong></td></tr>`;
  }).join("");

  const computedNote =
    ctx.computed?.sum != null
      ? `<p><strong>Total (solicitado): ${ctx.computed.sum.toLocaleString("es-ES")}</strong>${filterDesc ? ` (${filterDesc})` : ""}</p>`
      : "";

  const answer_html = `<table><thead><tr><th>Concepto</th><th>Valor</th></tr></thead><tbody>${rows}</tbody></table>${computedNote}`;
  const answer =
    htmlToPlainText(answer_html) +
    (ctx.computed?.sum != null ? ` Total: ${ctx.computed.sum.toLocaleString("es-ES")}.` : "");

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
  const computed =
    ctx.computed?.sum != null
      ? ` Suma (solo porque el usuario pidió total): ${ctx.computed.sum.toLocaleString("es-ES")}.`
      : "";
  return `Pregunta: "${ctx.originalQuestion}". Datos: ${data}.${computed} ${filters ? "Filtros: " + filters + "." : ""} Responde en español con HTML semántico (tabla si hay varios datos). No inventes totales.`;
}
