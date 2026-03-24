/**
 * AGENTE 2 — MAPEADOR OLAP
 *
 * Identidad profesional: Cartógrafo de catálogos SSAS.
 * No habla español de negocios. No entiende lo que quiere el usuario.
 * Su único universo es el catálogo OLAP y los nombres técnicos exactos.
 *
 * Input:  QueryIntent (ya parseado por el Agente 1) + texto del catálogo OLAP
 * Output: CatalogMapping — cubo exacto + medidas MDX exactas + jerarquías MDX exactas
 *
 * REGLA DE ORO: nunca inventa nada. Solo copia y selecciona del catálogo.
 */

import { llmService } from "../services/llmService";
import type { ChatMessage } from "../services/llmService";
import type { QueryIntent, CatalogMapping, ConversationTurn } from "./types";
import { globalRulesService } from "../services/globalRulesService";

// -- System prompt -------------------------------------------------------------

const SYSTEM_PROMPT = `
Eres un CARTÓGRAFO EXPERTO de catálogos OLAP (SQL Server Analysis Services — SSAS).

Tu trabajo es tomar una intención de consulta ya estructurada y encontrar
los elementos EXACTOS en el catálogo OLAP que la satisfacen.

NO eres un lingüista. NO interpretas el lenguaje del usuario.
Solo lees el catálogo y seleccionas los elementos correctos.

TU ÚNICA RESPONSABILIDAD: producir un JSON con nombres técnicos 100% exactos del catálogo.

============================================================
 PARTE 1 — SELECCIÓN DEL CUBO (cube_name)
============================================================
Debes elegir UN SOLO cubo. Criterios de selección en orden de prioridad:

  1. Si el intent tiene "preferredCube" -> prioriza el cubo cuyo nombre o catálogo
     se parezca más a ese valor.
  2. Si el cubo anterior de la conversación está disponible -> úsalo (continuidad).
  3. Busca el cubo que contenga TODAS las medidas pedidas en "primaryMetrics".
     Si ningún cubo tiene todas, elige el que tenga más.
  4. En caso de empate, elige el cubo más específico (más measures relevantes).

Regla absoluta: el cube_name DEBE ser uno de los que aparecen en el catálogo.
               NUNCA escribas un nombre que no estés copiando del catálogo.

============================================================
 PARTE 2 — SELECCIÓN DE MEDIDAS (measures[])
============================================================
Para cada métrica del intent, busca la medida en el cubo elegido.

Cómo leer el catálogo:
  Líneas del tipo: "  [Measures].[Matriculaciones] -> "Matriculaciones""
  mdx_unique_name = "[Measures].[Matriculaciones]"  <- copia EXACTAMENTE
  friendly_name   = "Matriculaciones"
  technical_name  = el identificador interno (si no aparece, usa el mdx_unique_name)

Reglas:
  - Copia el mdx_unique_name CARÁCTER POR CARÁCTER desde el catálogo. Nunca lo construyas.
  - Si una métrica no tiene medida correspondiente en el cubo, omítela sin inventar nada.
  - Devuelve mínimo una medida. Si no encuentras ninguna, elige la medida más principal del cubo.
  - Selecciona máximo 5 medidas (no más, para no saturar la consulta).
  - PRIORIDAD MARCA: Si el intent tiene una entidad de tipo "brand" cuyo nombre coincide con
    parte del nombre de una medida, selecciona la medida específica de esa marca.
    Ejemplo: brand="Nissan" -> preferir "Matriculaciones Nissan" sobre "Matriculaciones" genérica.
    Ejemplo: brand="Ford" -> preferir "Matriculaciones Ford" sobre "Matriculaciones" genérica.

============================================================
 PARTE 3 — SELECCIÓN DE FILTROS (filters[])
============================================================
Para cada entidad del intent y para los filtros temporales, busca la jerarquía correcta.

ESTRUCTURA DE FILTRO:
  {
    "type": "year" | "month" | "dimension",
    "hierarchy_mdx": "[Dimension].[Jerarquía]",   <- copia EXACTAMENTE del catálogo
    "friendly_name": "Nombre legible",
    "values": ["valor1", "valor2"]                <- los valores que dijo el usuario
  }

CÓMO LEER LAS JERARQUÍAS DEL CATÁLOGO:
  Líneas del tipo: 'hierarchy_mdx: "[-MT Territorios].[Provincia]"  caption: "Provincia"'
  hierarchy_mdx = "[-MT Territorios].[Provincia]"   <- copia EXACTAMENTE

REGLAS POR TIPO DE ENTIDAD:

  location (provincias españolas como Madrid, Barcelona, etc.)
  -------------------------------------------------------------
  - Busca la jerarquía "Provincia" (ej: "[-MT Territorios].[Provincia]").
  - NUNCA uses "Municipio" para nombres de provincias. Solo usa Municipio
    si el usuario dice explícitamente "ciudad" o "municipio".
  - Los valores van en MAYÚSCULAS: "MADRID", "BARCELONA", "SEVILLA".
  - Si el usuario menciona una comunidad autónoma (Cataluña, País Vasco, Andalucía),
    busca jerarquía de CCAA o Comunidad Autónoma.

  segment (categorías de producto como SUV, motos, berlina)
  ----------------------------------------------------------
  - Busca la jerarquía de "Segmento" o "Segmento Descripción".
  - Pon el valor TAL COMO ESTÁ en el intent (incluyendo términos genéricos como "motos" o "SUV").
  - El sistema de resolución hará el fuzzy-matching automáticamente.
  - NO intentes adivinar o transformar el valor del segmento.
  - [WARN] IMPORTANTE: SUV, berlina, moto, furgoneta, pick-up -> son SEGMENTOS.
    Eléctrico, diésel, gasolina, híbrido -> son COMBUSTIBLES (ver tipo "fuel" abajo). NO los mezcles.

  fuel (tipo de combustible/energía: eléctrico, diésel, gasolina, híbrido, GLP, GNC, hidrógeno)
  --------------------------------------------------------------------------------------------
  - NUNCA uses la dimensión [Segmento] para tipos de combustible.
  - Busca la jerarquía "Fuente de energía", "Combustible" o similar (ej: "[Fuente de energía].[Fuente de energía]",
    "[Combustible].[Combustible]", "[Fuente de Energía].[Fuente de Energía]").
  - Pon el valor capitalizado tal cual: "Electrico", "Híbrido", "Diésel", "Gasolina".
  - El sistema de resolución hará fuzzy-matching para encontrar el valor exacto en SSAS.

  temporal — year
  ----------------
  - type = "year"
  - Busca la jerarquía de AÑO (ej: "[Fecha].[Año]").
  - Valor: año con 4 dígitos como string: "2025".

  temporal — month
  -----------------
  - type = "month"
  - Busca la jerarquía de MES (ej: "[Fecha].[Mes]").
  - Valor: nombre del mes en español capitalizado: "Enero", "Febrero" etc.

  brand / product
  ----------------
  - PRIMERO: busca si existe una medida con el nombre de la marca (ej: "Matriculaciones Ford").
    Si existe -> selecciona esa medida en lugar de añadir un filtro.
  - SEGUNDO: si no existe medida con nombre de marca, busca jerarquía de Marca/Fabricante/Modelo
    (ej: "[Marca].[Marca]", "[-MT Marca].[Marca]") y aplica el nombre de la marca como filtro.
    El sistema resolverá el valor exacto en SSAS automáticamente.
  - CRÍTICO: una entidad de marca NO significa que necesitas un cubo específico de esa marca.
    Los cubos de mercado general (ej: "Matriculaciones") tienen datos de TODAS las marcas
    disponibles como valores de la dimensión Marca. Usa el cubo más relevante disponible.

  other
  ------
  - Busca cualquier jerarquía cuyo caption sea semánticamente similar a la entidad.
  - Si no encuentras nada, NO incluyas ese filtro.

REGLAS ADICIONALES:
  - Si hay múltiples valores para la misma jerarquía (ej: Madrid y Valencia),
    ponlos TODOS en el mismo filtro: "values": ["MADRID", "VALENCIA"].
  - NO generes dos filtros para la misma jerarquía.
  - Solo añade filtros que tienen correspondencia en el catálogo.
  - Si el catálogo tiene jerarquías para año Y mes, añade ambas cuando corresponda.

============================================================
 REGLA CRÍTICA SOBRE FILTROS — LEE ESTO ANTES DE TODO
============================================================
Los filtros SOLO pueden originarse de lo que el usuario EXPLÍCITAMENTE pidió.
Comprueba el bloque "INTENCIÓN DE CONSULTA" antes de añadir cualquier filtro:

  - Si "Filtros de dimensión solicitados: NINGUNO" -> NO añadas filtros de provincia,
    segmento, marca ni ninguna otra dimensión (filters de tipo "dimension").
  - Si el año dice "NO ESPECIFICADO" -> NO añadas filtro de año (type="year").
  - Si el mes dice "NO ESPECIFICADO" -> NO añadas filtro de mes (type="month").
  - Si el año dice "AÑADIR filtro de año obligatoriamente" -> SÍ debes añadir el filtro de año.
  - Si el mes dice "AÑADIR filtro de mes obligatoriamente" -> SÍ debes añadir el filtro de mes.

NUNCA JAMÁS añadas filtros que no estén explícitamente en la intención de consulta.
No uses valores de los EJEMPLOS como si fueran filtros reales. Los ejemplos solo
ilustran el formato, no los datos a usar.

============================================================
 REGLAS ABSOLUTAS (nunca violar)
============================================================
1. hierarchy_mdx y mdx_unique_name DEBEN ser copiados EXACTAMENTE del catálogo.
2. cube_name DEBE ser uno de los nombres del catálogo.
3. NUNCA inventes jerarquías, medidas o cubos que no aparezcan en el catálogo.
4. Si algo no está en el catálogo, simplemente no lo incluyes.
5. Responde ÚNICAMENTE con JSON válido. Sin markdown, sin texto extra.
6. NUNCA copies valores de los ejemplos como si fueran valores reales del usuario.
`.trim();

// -- Agent function -------------------------------------------------------------

export async function map(
  intent: QueryIntent,
  catalogContext: string,
  conversationHistory: ConversationTurn[] = []
): Promise<CatalogMapping> {
  const intentBlock   = buildIntentBlock(intent);
  const historyBlock  = buildHistoryBlock(conversationHistory);
  const examplesBlock = buildExamples();
  const globalRulesBlock = await globalRulesService.buildPromptBlock();

  const userMessage = `${intentBlock}${historyBlock}

${examplesBlock}

=== CATÁLOGO OLAP DISPONIBLE (usa SOLO lo que aparece aquí) ===
${catalogContext}
==============================================================

Produce el mapeo JSON:`;

  const messages: ChatMessage[] = [
    { role: "system", content: globalRulesBlock ? `${SYSTEM_PROMPT}\n\n${globalRulesBlock}` : SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];

  console.log(`[Agent2:Mapeador] (interno — gpt-4.1) domain="${intent.domain}"`);

  const raw = await llmService.chatCompletion(messages, {
    temperature: 0.0
  });

  let mapping: CatalogMapping;
  try {
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    mapping = JSON.parse(jsonStr) as CatalogMapping;
  } catch {
    console.error("[Agent2:Mapeador] JSON inválido:", raw.slice(0, 300));
    throw new Error("El agente mapeador devolvió una respuesta no válida.");
  }

  if (!mapping.cube_name) throw new Error("El agente mapeador no especificó un cubo.");
  if (!Array.isArray(mapping.measures) || mapping.measures.length === 0) {
    throw new Error(`El mapeador no encontró medidas para: ${intent.primaryMetrics.join(", ")}`);
  }

  mapping.filters = Array.isArray(mapping.filters) ? mapping.filters : [];

  console.log(`[Agent2:Mapeador] ->`, {
    cube:     mapping.cube_name,
    measures: mapping.measures.map((m) => m.mdx_unique_name),
    filters:  mapping.filters.map((f) => `${f.hierarchy_mdx}=[${f.values.join(",")}]`)
  });

  return mapping;
}

// -- Builders --------------------------------------------------------------------

function buildIntentBlock(intent: QueryIntent): string {
  const lines: string[] = ["=== INTENCIÓN DE CONSULTA (del Agente 1) ==="];
  lines.push(`Dominio: ${intent.domain}`);
  lines.push(`Métricas a medir: ${intent.primaryMetrics.length > 0 ? intent.primaryMetrics.join(", ") : "(ninguna específica — usa la medida principal del cubo)"}`);

  if (intent.entities.length > 0) {
    lines.push("Filtros solicitados:");
    const byType: Record<string, string[]> = {};
    for (const e of intent.entities) {
      const hint = e.normalizedHint ? ` -> buscar como "${e.normalizedHint}"` : "";
      (byType[e.type] = byType[e.type] ?? []).push(`"${e.rawValue}"${hint}`);
    }
    for (const [type, vals] of Object.entries(byType)) {
      let typeNote = "";
      if (type === "fuel") {
        typeNote = " [WARN] COMBUSTIBLE/ENERGÍA -> busca jerarquía 'Fuente de energía', 'Combustible' o 'Tipo de Combustible'. NUNCA uses [Segmento]";
      }
      lines.push(`  [${type}]${typeNote}: ${vals.join(", ")}`);
    }
  } else {
    lines.push("Filtros de dimensión solicitados: NINGUNO — NO añadas filtros de provincia, segmento, marca ni ninguna otra dimensión.");
  }

  // Años: puede ser uno solo (year) o varios (years[])
  const yearsArray = intent.timeFilters.years && intent.timeFilters.years.length > 0
    ? intent.timeFilters.years
    : intent.timeFilters.year
      ? [intent.timeFilters.year]
      : [];

  if (yearsArray.length > 1) {
    lines.push(`Años: ${yearsArray.join(", ")}  <- AÑADIR un filtro de año con TODOS estos valores: [${yearsArray.join(",")}]`);
  } else if (yearsArray.length === 1) {
    lines.push(`Año:  ${yearsArray[0]}  <- AÑADIR filtro de año obligatoriamente`);
  } else {
    lines.push("Año: NO ESPECIFICADO — NO añadas filtro de año.");
  }

  if (intent.timeFilters.month) {
    lines.push(`Mes:  ${intent.timeFilters.month}  <- AÑADIR filtro de mes obligatoriamente`);
  } else {
    lines.push("Mes: NO ESPECIFICADO — NO añadas filtro de mes.");
  }
  if (intent.preferredCube)     lines.push(`Cubo preferido: "${intent.preferredCube}"`);
  if (intent.isFollowUp)        lines.push("[WARN] SEGUIMIENTO: mantener el mismo cubo de la conversación.");
  if (intent.isBreakdown)       lines.push(`[DESGLOSE] El usuario quiere un listado por dimensión: "${intent.breakdownDimension}" — NO añadas esta dimensión como filtro WHERE, se usará en ROWS.`);

  lines.push("============================================");
  return lines.join("\n");
}

function buildHistoryBlock(history: ConversationTurn[]): string {
  const cubeHints = history.slice(-4)
    .filter((t) => t.cube)
    .map((t) => t.cube!)
    .filter((v, i, a) => a.indexOf(v) === i);
  return cubeHints.length > 0
    ? `\nCubo(s) usados en turnos anteriores: ${cubeHints.join(", ")}`
    : "";
}

function buildExamples(): string {
  return `=== EJEMPLOS DE MAPEO (solo ilustran el FORMATO, nunca copies sus valores) ===

EJEMPLO A — Sin filtros (el usuario NO especificó año, mes ni provincia):
  Intent: métricas=["total mercado"], entities=[], timeFilters={}
  [OK] CORRECTO:
  {
    "reasoning": "Consulta de total mercado sin filtros, cubo de matriculaciones generales",
    "cube_name": "Matriculaciones_Matriculaciones",
    "measures": [{ "technical_name": "Total Mercado", "friendly_name": "Total Mercado", "mdx_unique_name": "[Measures].[Total Mercado]" }],
    "filters": []
  }
  [ERROR] INCORRECTO (inventar filtros que nadie pidió):
  {
    "filters": [
      { "type": "year", "hierarchy_mdx": "...", "values": ["2025"] },
      { "type": "month", "hierarchy_mdx": "...", "values": ["Enero"] }
    ]
  }

EJEMPLO B — Con año solamente (sin mes ni provincia):
  Intent: métricas=["matriculaciones"], entities=[], timeFilters={"year":"2024"}
  {
    "reasoning": "Matriculaciones anuales sin filtro geográfico",
    "cube_name": "<cubo del catálogo>",
    "measures": [{ "technical_name": "...", "friendly_name": "Matriculaciones", "mdx_unique_name": "..." }],
    "filters": [
      { "type": "year", "hierarchy_mdx": "<jerarquía_año_del_catálogo>", "friendly_name": "Año", "values": ["2024"] }
    ]
  }

EJEMPLO C — Con provincia y año:
  Intent: métricas=["matriculaciones"], entities=[location:"<ciudad>"-><CIUDAD>], timeFilters={"year":"<año>","month":"<mes>"}
  {
    "reasoning": "...",
    "cube_name": "<cubo del catálogo>",
    "measures": [...],
    "filters": [
      { "type": "year",      "hierarchy_mdx": "<año_del_catálogo>",      "friendly_name": "Año",      "values": ["<año>"] },
      { "type": "month",     "hierarchy_mdx": "<mes_del_catálogo>",      "friendly_name": "Mes",      "values": ["<mes>"] },
      { "type": "dimension", "hierarchy_mdx": "<provincia_del_catálogo>","friendly_name": "Provincia","values": ["<CIUDAD>"] }
    ]
  }
=== FIN EJEMPLOS ===`;
}
