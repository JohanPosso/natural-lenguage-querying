import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { mdxBridgeService } from "../services/mdxBridgeService";
import { catalogService } from "../services/catalogService";
import type { XmlaManifest } from "../services/catalogService";
import { debugLogger } from "../services/debugLogger";
import * as interpreterAgent from "../agents/interpreterAgent";
import * as mapperAgent from "../agents/mapperAgent";
import * as responseAgent from "../agents/responseAgent";
import type { ConversationTurn } from "../agents/types";
import { normalizeJargon } from "../data/automotiveJargon";

// Re-export for chatController (backward compat)
export type { ConversationTurn };

// ── Types ───────────────────────────────────────────────────────────────────

type ManifestCube = XmlaManifest["cubes"][number];
type ManifestMember = ManifestCube["members"][number];

// LlmFilter and LlmSelection are now sourced from the agents
import type { CatalogMapping, MappedFilter, MappedMeasure } from "../agents/types";

type LlmFilter = MappedFilter;
type LlmSelection = CatalogMapping;

/** A single resolved member for a hierarchy */
type ResolvedMember = {
  value_caption: string;
  member_unique_name: string;
};

/** All resolved members for one hierarchy dimension (may be multiple when user asks "Madrid y Valencia") */
type ResolvedFilterGroup = {
  hierarchy_friendly: string;
  hierarchy_mdx: string;
  members: ResolvedMember[];
};

/** A single filter value in a WHERE-clause tuple */
type FilterTuple = {
  dimension_friendly: string;
  dimension_mdx: string;
  value_caption: string;
  member_unique_name: string;
};

type MeasureResult = {
  technical_name: string;
  friendly_name: string;
  cube_name: string;
  mdx: string;
  value: string | null;
  catalog: string;
  filter_combo: FilterTuple[];
  filter_label: string;
};

export type AskResponsePayload = {
  question: string;
  answer: string;
  data: {
    value: string | null;
    cube: string | null;
    measure: string | null;
    mdx: string | null;
    results: MeasureResult[];
    selection: Partial<CatalogMapping>;
  };
};

// ── Console pipeline logger ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

function pLog(icon: string, color: string, label: string, detail = ""): void {
  const ts = new Date().toISOString().slice(11, 23);
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`${DIM}[${ts}]${RESET} ${color}${icon} ${BOLD}${label}${RESET}${detailStr}`);
}

// ── Text utilities ──────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "y", "e", "en", "para",
  "por", "con", "sin", "un", "una", "unos", "unas", "que", "cuantos",
  "cuantas", "cuanto", "me", "puedes", "dime", "es", "al", "a", "o",
  "hay", "quiero", "saber", "cual", "cuales", "ver", "necesito", "dame"
]);

function extractTokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d{4}$/.test(t));
}

function scoreMatch(haystack: string, tokens: string[]): number {
  const norm = normalize(haystack);
  return tokens.reduce((acc, t) => (norm.includes(t) ? acc + 1 : acc), 0);
}

/** Normalize LLM filter output to support both old-format (dimension_mdx/value) and new-format */
function normalizeFilters(rawFilters: unknown[]): LlmFilter[] {
  return (rawFilters ?? [])
    .map((f: unknown) => {
      const filter = f as Record<string, unknown>;
      return {
        type: (filter.type ?? "dimension") as LlmFilter["type"],
        hierarchy_mdx: String(filter.hierarchy_mdx ?? filter.dimension_mdx ?? ""),
        friendly_name: String(filter.friendly_name ?? ""),
        values: Array.isArray(filter.values)
          ? (filter.values as string[]).map(String)
          : filter.value
            ? [String(filter.value)]
            : []
      };
    })
    .filter((f) => f.hierarchy_mdx && f.values.length > 0);
}

// ── Cube pre-filtering ──────────────────────────────────────────────────────

function prefilterCubes(
  manifest: XmlaManifest,
  question: string,
  topN: number,
  prevCubeName?: string | null
): ManifestCube[] {
  const tokens = extractTokens(question);

  const scored = manifest.cubes.map((cube) => {
    const nameScore = scoreMatch(`${cube.cubeName} ${cube.catalog}`, tokens) * 4;
    let measureScore = 0;
    for (const m of cube.members) {
      if (m.type !== "measure") continue;
      const s = scoreMatch(m.friendlyName, tokens);
      if (s > 0) measureScore += s;
    }
    const stickyBonus = prevCubeName && cube.cubeName === prevCubeName ? 20 : 0;
    return { cube, score: nameScore + Math.min(measureScore, 10) + stickyBonus };
  });

  const sorted = scored.sort((a, b) => b.score - a.score);
  const topScored = sorted.filter(({ score }) => score > 0).slice(0, topN);
  return topScored.length ? topScored.map(({ cube }) => cube) : manifest.cubes.slice(0, topN);
}

/**
 * Improved cube pre-filter: uses structured QueryIntent signals instead of raw tokens.
 * The interpreter agent produces much better signals:
 *  - preferredCube → direct strong match (50 pts)
 *  - primaryMetrics → match against measure names (up to 15 pts)
 *  - entities (brand/product) → match against cube name/catalog (8 pts each)
 *  - domain → match against catalog names (5 pts)
 *  - prevCubeName → sticky bonus (20 pts)
 */
function prefilterCubesByIntent(
  cubes: ManifestCube[],
  intent: import("../agents/types").QueryIntent,
  rawQuestion: string,
  topN: number,
  prevCubeName?: string | null
): ManifestCube[] {
  const scored = cubes.map((cube) => {
    let score = 0;

    // Explicit cube preference from user (strongest signal)
    if (intent.preferredCube) {
      const normPref = normalize(intent.preferredCube);
      if (
        normalize(cube.cubeName).includes(normPref) ||
        normalize(cube.catalog).includes(normPref) ||
        normPref.includes(normalize(cube.cubeName))
      ) {
        score += 50;
      }
    }

    // Metric matching against measure names
    for (const metric of intent.primaryMetrics) {
      const normMetric = normalize(metric);
      for (const m of cube.members) {
        if (m.type !== "measure") continue;
        if (normalize(m.friendlyName).includes(normMetric)) {
          score += 5;
          break;
        }
      }
    }

    // Brand/product entity matching against cube name
    for (const entity of intent.entities) {
      if (entity.type === "brand" || entity.type === "product") {
        const normVal = normalize(entity.normalizedHint ?? entity.rawValue);
        if (normalize(cube.catalog).includes(normVal) || normalize(cube.cubeName).includes(normVal)) {
          score += 8;
        }
      }
    }

    // Domain matching against catalog name
    const normDomain = normalize(intent.domain.replace(/_/g, " "));
    const normCatalog = normalize(cube.catalog);
    if (normCatalog.includes(normDomain.split(" ")[0] ?? "")) score += 5;

    // Sticky bonus for previous cube (conversation continuity)
    if (prevCubeName && cube.cubeName === prevCubeName) score += 20;

    // ── REGLA: queries genéricas sin marca → priorizar cubo de mercado general ──
    // Con pocos cubos visibles (≤5) la penalización es suave para no descartar ninguno.
    const hasBrandEntity = intent.entities.some((e) => e.type === "brand" || e.type === "product");
    const isGenericMarketQuery = !hasBrandEntity && !intent.preferredCube;
    const isGenericCube = normalize(cube.cubeName).includes("matriculacion") ||
      normalize(cube.catalog).includes("matriculacion");
    // Un cubo "de marca" es uno cuyo catálogo no es un cubo de mercado general Y tiene
    // medidas cuyo nombre incluye la marca del cubo. Se detecta dinámicamente para no
    // depender de una lista hardcodeada de nombres de marca.
    const catalogNorm = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
    const isBrandedCube =
      catalogNorm.length > 2 &&
      !isGenericCube &&
      cube.members.some(
        (m) => m.type === "measure" && normalize(m.friendlyName).includes(catalogNorm)
      );

    // Cuando el usuario pregunta algo genérico: bonificar el cubo de mercado, penalizar menos los branded
    if (isGenericMarketQuery && isGenericCube) score += 25;
    if (isGenericMarketQuery && isBrandedCube && cubes.length > 3) score -= 15; // solo penalizar si hay cubo específico disponible

    // Cuando el usuario menciona una marca y hay un cubo branded: bonificar ese cubo branded
    // aunque la marca no coincida EXACTAMENTE (ej: pregunta Ford → cubo Nissan no recibe bonus,
    // pero tampoco se penaliza mucho si no hay mejor opción)
    if (hasBrandEntity && isGenericCube) score += 10; // el cubo general de mercado siempre puede filtrar por marca
    // ─────────────────────────────────────────────────────────────────────────

    return { cube, score };
  });

  // Fall back to raw question token scoring if intent signals don't distinguish
  if (scored.every(({ score }) => score === 0 || score === 20)) {
    return prefilterCubes({ cubes } as XmlaManifest, rawQuestion, topN, prevCubeName);
  }

  const sorted = scored.sort((a, b) => b.score - a.score);
  // Con pocos cubos disponibles (≤5), enviar TODOS al mapper aunque tengan score 0
  // El mapper tiene más contexto y puede decidir mejor que el scoring simple.
  if (cubes.length <= 5) {
    return sorted.map(({ cube }) => cube);
  }
  const topScored = sorted.filter(({ score }) => score > 0).slice(0, topN);
  return topScored.length ? topScored.map(({ cube }) => cube) : cubes.slice(0, topN);
}

function prefilterMeasures(cube: ManifestCube, question: string, topN: number): ManifestMember[] {
  const tokens = extractTokens(question);
  const measures = cube.members.filter((m) => m.type === "measure");
  // Cubos pequeños (≤ topN medidas): enviar TODAS sin filtrar. No tiene sentido truncar.
  if (!tokens.length || measures.length <= topN) return measures.slice(0, topN);

  const brandSuffix = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
  const qNorm = normalize(question);

  // Detectar si la query pide el MERCADO TOTAL (vs específico de marca)
  const asksForMarket = qNorm.includes("mercado") && !qNorm.includes(brandSuffix);
  // Detectar si la query pide datos de la marca específica del cubo
  const asksForBrand = qNorm.includes(brandSuffix) && brandSuffix.length > 2;

  const scored = measures
    .map((m, idx) => {
      let score = scoreMatch(m.friendlyName, tokens);
      const mNorm = normalize(m.friendlyName);

      // Pequeño bonus de posición: las primeras medidas del cubo son "principales"
      // y deben incluirse aunque tengan 0 tokens de overlap (max +0.5 para la primera).
      score += Math.max(0, 0.5 - idx * 0.002);

      // Cuando el usuario pide el total mercado, penalizar medidas brand-específicas
      // y bonificar las genéricas (sin sufijo de marca)
      if (asksForMarket && !asksForBrand && brandSuffix.length > 2) {
        if (mNorm.includes(brandSuffix)) score -= 3;  // penalizar Nissan-específicas
        if (!mNorm.includes(brandSuffix)) score += 1; // bonificar genéricas
      }

      // Cuando el usuario pide datos de la marca, bonificar medidas de esa marca
      if (asksForBrand && brandSuffix.length > 2 && mNorm.includes(brandSuffix)) {
        score += 2;
      }

      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  // Garantizar que las top-10 medidas del cubo (por orden de catálogo) siempre estén
  // visibles aunque su score sea bajo — son las que el modelo considera "principales".
  const topByScore = scored.slice(0, topN).map(({ m }) => m);
  const topByPosition = measures.slice(0, 10);
  const combined = [...topByScore];
  for (const m of topByPosition) {
    if (!combined.find((x) => x.mdxUniqueName === m.mdxUniqueName)) {
      combined.push(m);
    }
  }
  return combined.slice(0, topN + 10); // un margen extra para no truncar importantes
}

// ── Catalog context builder (async — enriches with XMLA hierarchy info) ─────

/**
 * Builds the catalog context for the LLM.
 * CRITICAL improvement: fetches actual hierarchy paths from SSAS via MDSCHEMA_HIERARCHIES
 * so the LLM can reference [Fecha].[Año] instead of just [Fecha].
 */
/**
 * Genera una nota automática para el mapper cuando un cubo contiene medidas genéricas
 * (sin sufijo de marca) Y medidas específicas de marca (con sufijo).
 * Esto evita que el mapper confunda "Matriculaciones" (total mercado) con "Matriculaciones Nissan".
 */
function buildMeasureSemanticNote(cube: ManifestCube): string {
  const measureNames = cube.members
    .filter((m) => m.type === "measure")
    .map((m) => m.friendlyName);

  const notes: string[] = [];

  // Detectar pares genérico vs específico-de-marca
  const brandSuffix = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
  const genericPairs: Array<{ generic: string; branded: string }> = [];
  for (const name of measureNames) {
    const norm = normalize(name);
    if (!norm.includes(brandSuffix) && brandSuffix.length > 2) {
      const brandedVariant = measureNames.find(
        (n) => normalize(n).includes(norm) && normalize(n).includes(brandSuffix)
      );
      if (brandedVariant && name !== brandedVariant) {
        genericPairs.push({ generic: name, branded: brandedVariant });
      }
    }
  }

  if (genericPairs.length > 0) {
    notes.push("NOTA SEMÁNTICA CRÍTICA — Lee antes de elegir medidas:");
    notes.push(
      `  En este cubo hay medidas GENÉRICAS (total mercado) y medidas ESPECÍFICAS de marca (${cube.catalog}).`
    );
    for (const pair of genericPairs.slice(0, 6)) {
      notes.push(
        `  • "${pair.generic}" = TOTAL MERCADO (todas las marcas, incluida la competencia)`
      );
      notes.push(`  • "${pair.branded}" = Solo ${cube.catalog}`);
    }
    notes.push(
      `  → Si el usuario pide "matriculaciones del mercado", "mercado total", "mercado DGT" o similar → usa la medida GENÉRICA.`
    );
    notes.push(
      `  → Si el usuario pide las de la marca ("${brandSuffix}", "nosotros", "nuestra marca") → usa la medida ESPECÍFICA.`
    );
  }

  return notes.join("\n");
}

async function buildCatalogContextWithHierarchies(
  cubes: ManifestCube[],
  question: string
): Promise<string> {
  const lines: string[] = [];

  for (const cube of cubes) {
    lines.push(
      `=== CUBO: "${cube.cubeName}" | catalog: "${cube.catalog}" | xmlaCubeName: "${cube.xmlaCubeName}" ===`
    );

    // Nota semántica automática (genérico vs marca-específico)
    const semanticNote = buildMeasureSemanticNote(cube);
    if (semanticNote) {
      lines.push(semanticNote);
      lines.push("");
    }

    const topMeasures = prefilterMeasures(cube, question, 50);
    lines.push("MEDIDAS (relevantes para la pregunta):");
    for (const m of topMeasures) {
      lines.push(`  ${m.mdxUniqueName} → "${m.friendlyName}"`);
    }

    // Fetch real hierarchy paths from SSAS (cached after first call)
    let hierarchies: Awaited<ReturnType<typeof catalogService.getHierarchiesForCube>> = [];
    try {
      hierarchies = await catalogService.getHierarchiesForCube(cube.catalog, cube.xmlaCubeName);
    } catch {
      // Non-fatal: fall back to dimension-only display
    }

    const dims = cube.members.filter((m) => m.type === "dimension");
    lines.push(
      "DIMENSIONES Y JERARQUÍAS — usa el valor de hierarchy_mdx EXACTO para los filtros; soporta múltiples valores:"
    );

    for (const d of dims) {
      // Match por equality (ideal) O por prefijo (fallback cuando dimension_unique_name
      // fue guardada igual a hierarchy_unique_name en el import, ej: "[-MT Producto].[Marca]"
      // en lugar de "[-MT Producto]"). El prefijo busca todas las jerarquías que pertenecen
      // a este espacio de nombres de dimensión.
      const dimHierarchies = hierarchies.filter(
        (h) =>
          h.dimensionUniqueName === d.mdxUniqueName ||
          h.hierarchyUniqueName.startsWith(d.mdxUniqueName + ".")
      );
      if (dimHierarchies.length > 0) {
        lines.push(`  Dimensión ${d.mdxUniqueName} ("${d.friendlyName}"):`);
        for (const h of dimHierarchies) {
          lines.push(`    hierarchy_mdx: "${h.hierarchyUniqueName}"  caption: "${h.hierarchyCaption}"`);
        }
      } else {
        lines.push(`  ${d.mdxUniqueName} ("${d.friendlyName}")`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}


// ── Cube resolution ─────────────────────────────────────────────────────────

function resolveCube(manifest: XmlaManifest, selectedName: string): ManifestCube {
  // 1) Exact match by cubeName
  const exact = manifest.cubes.find((c) => c.cubeName === selectedName);
  if (exact) return exact;

  // 2) Partial / contains match (normalized)
  const normSelected = normalize(selectedName);
  const partial = manifest.cubes.find(
    (c) =>
      normalize(c.cubeName).includes(normSelected) ||
      normSelected.includes(normalize(c.cubeName)) ||
      normalize(c.catalog).includes(normSelected) ||
      normSelected.includes(normalize(c.catalog))
  );
  if (partial) {
    console.warn(`[askController] LLM selected cube "${selectedName}", resolved to "${partial.cubeName}"`);
    return partial;
  }

  // 3) Token-based similarity fallback: pick the cube whose name shares the most tokens
  // with the selected name. This avoids throwing when the mapper uses a slightly
  // different label (e.g. "Matriculaciones" vs "Matriculaciones_Matriculaciones").
  const tokens = extractTokens(selectedName);
  if (tokens.length > 0) {
    const scored = manifest.cubes.map((c) => ({
      cube: c,
      score: scoreMatch(`${c.cubeName} ${c.catalog}`, tokens)
    }));
    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (best && best.score > 0) {
      console.warn(
        `[askController] No exact match for "${selectedName}", using best-score fallback: "${best.cube.cubeName}" (score=${best.score})`
      );
      return best.cube;
    }
  }

  // 4) Last resort: use the first available cube and log a warning
  if (manifest.cubes.length > 0) {
    console.warn(
      `[askController] Could not resolve "${selectedName}" — defaulting to first available cube: "${manifest.cubes[0].cubeName}"`
    );
    return manifest.cubes[0];
  }

  throw new Error(
    `El cubo "${selectedName}" no existe en el catálogo y no hay cubos de fallback disponibles.`
  );
}

// ── Filter resolution ────────────────────────────────────────────────────────

type FilterExpansion = {
  original: string;          // term the user used  ("SUV", "motos")
  expanded: string[];        // what it resolved to  (["ASUV","BSUV",...] / ["Moto Carretera",...])
  friendly_name: string;     // hierarchy label
};

type FilterResolutionResult = {
  groups:     ResolvedFilterGroup[];
  unresolved: Array<{ hierarchy_mdx: string; friendly_name: string; values: string[] }>;
  expansions: FilterExpansion[];  // terms expanded to multiple members
};

/**
 * Resolves each filter value to an exact SSAS member unique name via XMLA DISCOVER.
 * Supports multiple values per hierarchy (e.g. MADRID and VALENCIA for [Provincia]).
 * Tracks which values could not be resolved so the response can inform the user.
 */
async function resolveFilters(
  cube: ManifestCube,
  filters: LlmFilter[],
  traceId: string
): Promise<FilterResolutionResult> {
  const groups:     ResolvedFilterGroup[] = [];
  const unresolved: Array<{ hierarchy_mdx: string; friendly_name: string; values: string[] }> = [];
  const expansions: FilterExpansion[] = [];

  for (const filter of filters ?? []) {
    if (!filter.hierarchy_mdx || !filter.values?.length) continue;

    const resolvedMembers: ResolvedMember[] = [];
    const unresolvedValues: string[] = [];

    for (const rawValue of filter.values) {
      if (!rawValue) continue;
      try {
        const best = await mdxBridgeService.findBestMemberByCaption(
          cube.catalog,
          cube.xmlaCubeName,
          filter.hierarchy_mdx,
          rawValue
        );

        // Determine if the match is exact (caption === rawValue, case-insensitive)
        const normRaw = rawValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const normBest = best?.caption.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const isExact = best !== null && normBest === normRaw;

        if (isExact) {
          // Exact match — use this single member
          resolvedMembers.push({ value_caption: best!.caption, member_unique_name: best!.uniqueName });
          await debugLogger.log("ask", "filter_resolved_exact", {
            traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, resolved: best!.uniqueName
          });

        } else if (filter.type === "year") {
          // Year filter — build unique name directly (SSAS year unique names are predictable)
          const fallback = `${filter.hierarchy_mdx}.&[${rawValue}]`;
          resolvedMembers.push({ value_caption: rawValue, member_unique_name: fallback });
          await debugLogger.log("ask", "year_filter_fallback", { traceId, hierarchy: filter.hierarchy_mdx, fallback });

        } else {
          // Not exact — try multi-match strategies for umbrella terms (motos, SUV, etc.)

          // Strategy 1: prefix match — "motos"→["Moto Carretera","Moto Campo","Moto Scooter"]
          const prefixMatches = await mdxBridgeService.findMembersWithPrefix(
            cube.catalog, cube.xmlaCubeName, filter.hierarchy_mdx, rawValue
          );

          if (prefixMatches.length > 0) {
            for (const m of prefixMatches) resolvedMembers.push({ value_caption: m.caption, member_unique_name: m.uniqueName });
            await debugLogger.log("ask", "filter_prefix_match", { traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, matched: prefixMatches.map((m) => m.caption) });
            console.log(`[resolveFilters] Prefix "${rawValue}" → ${prefixMatches.map((m) => m.caption).join(", ")}`);
            if (prefixMatches.length > 1) {
              expansions.push({ original: rawValue, expanded: prefixMatches.map((m) => m.caption), friendly_name: filter.friendly_name || filter.hierarchy_mdx });
            }

          } else {
            // Strategy 2: contains match — "SUV" → [ASUV, BSUV, CSUV, DSUV, ESUV, FSUV]
            const containsMatches = await mdxBridgeService.findMembersContaining(
              cube.catalog, cube.xmlaCubeName, filter.hierarchy_mdx, rawValue
            );

            if (containsMatches.length >= 2) {
              // Múltiples contains → término paraguas (motos, SUV, etc.), incluir todos
              for (const m of containsMatches) resolvedMembers.push({ value_caption: m.caption, member_unique_name: m.uniqueName });
              await debugLogger.log("ask", "filter_contains_match", { traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, matched: containsMatches.map((m) => m.caption) });
              console.log(`[resolveFilters] Contains "${rawValue}" → ${containsMatches.map((m) => m.caption).join(", ")}`);
              expansions.push({ original: rawValue, expanded: containsMatches.map((m) => m.caption), friendly_name: filter.friendly_name || filter.hierarchy_mdx });

            } else if (containsMatches.length === 1) {
              // Un solo contains match → usarlo directamente (no es un término paraguas)
              const m = containsMatches[0];
              resolvedMembers.push({ value_caption: m.caption, member_unique_name: m.uniqueName });
              await debugLogger.log("ask", "filter_contains_single", { traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, resolved: m.uniqueName });
              console.log(`[resolveFilters] Contains(1) "${rawValue}" → ${m.caption}`);

            } else if (best) {
              // Sin contains, pero findBestMemberByCaption encontró algo → usar como best-effort
              resolvedMembers.push({ value_caption: best.caption, member_unique_name: best.uniqueName });
              await debugLogger.log("ask", "filter_resolved_partial", { traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, resolved: best.uniqueName });
              console.log(`[resolveFilters] Partial "${rawValue}" → ${best.caption}`);

            } else {
              unresolvedValues.push(rawValue);
              await debugLogger.log("ask", "filter_not_found", { traceId, hierarchy: filter.hierarchy_mdx, value: rawValue });
            }
          }
        }
      } catch (err) {
        unresolvedValues.push(rawValue);
        await debugLogger.log("ask", "filter_resolve_error", {
          traceId, hierarchy: filter.hierarchy_mdx, value: rawValue, error: (err as Error).message
        });
      }
    }

    if (resolvedMembers.length > 0) {
      groups.push({
        hierarchy_friendly: filter.friendly_name || filter.hierarchy_mdx,
        hierarchy_mdx: filter.hierarchy_mdx,
        members: resolvedMembers
      });
    }

    if (unresolvedValues.length > 0) {
      unresolved.push({
        hierarchy_mdx: filter.hierarchy_mdx,
        friendly_name: filter.friendly_name,
        values: unresolvedValues
      });
    }
  }

  return { groups, unresolved, expansions };
}

// ── Filter combination generation ────────────────────────────────────────────

const MAX_QUERY_COMBINATIONS = 100;

/**
 * Generates the Cartesian product of multi-value filter groups.
 * Single-value groups are always included in every combination.
 * Example: Province=[MADRID,VALENCIA] + Segment=[Moto Carretera] →
 *   [{MADRID, Moto Carretera}, {VALENCIA, Moto Carretera}]
 */
function generateFilterCombinations(groups: ResolvedFilterGroup[]): FilterTuple[][] {
  if (!groups.length) return [[]];

  const singleGroups = groups.filter((g) => g.members.length === 1);
  const multiGroups = groups.filter((g) => g.members.length > 1);

  const baseTuples: FilterTuple[] = singleGroups.flatMap((g) =>
    g.members.map((m) => ({
      dimension_friendly: g.hierarchy_friendly,
      dimension_mdx: g.hierarchy_mdx,
      value_caption: m.value_caption,
      member_unique_name: m.member_unique_name
    }))
  );

  if (!multiGroups.length) return [baseTuples];

  // Build cross-product of multi-value groups
  let combos: FilterTuple[][] = [[]];
  for (const group of multiGroups) {
    const expanded: FilterTuple[][] = [];
    for (const existing of combos) {
      for (const member of group.members) {
        expanded.push([
          ...existing,
          {
            dimension_friendly: group.hierarchy_friendly,
            dimension_mdx: group.hierarchy_mdx,
            value_caption: member.value_caption,
            member_unique_name: member.member_unique_name
          }
        ]);
      }
    }
    combos = expanded;
  }

  return combos.slice(0, MAX_QUERY_COMBINATIONS).map((combo) => [...baseTuples, ...combo]);
}

// ── MDX Execution ────────────────────────────────────────────────────────────

/**
 * Converts SSAS raw numeric strings (may be scientific notation like 1.08683E5)
 * into a clean integer or decimal string (e.g. "108683").
 * The LLM handles Spanish thousand-separator formatting in the final answer.
 */
function parseSsasNumber(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const num = parseFloat(str);
  if (isNaN(num)) return str; // not numeric, return as-is
  // If effectively integer, return without decimals
  if (Math.abs(num - Math.round(num)) < 0.001) return String(Math.round(num));
  // Otherwise keep up to 4 decimal places
  return parseFloat(num.toFixed(4)).toString();
}

function extractScalarValue(rows: unknown[]): string | null {
  if (!rows.length || typeof rows[0] !== "object" || rows[0] === null) return null;
  const firstRow = rows[0] as Record<string, unknown>;
  const firstKey = Object.keys(firstRow)[0];
  if (!firstKey) return null;
  const raw = firstRow[firstKey];
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj._ === "string" || typeof obj._ === "number") return String(obj._);
  }
  return null;
}

/**
 * Executes one MDX combination with progressive fallback:
 * 1. All filters
 * 2. Without date filters (year + month)
 * 3. No filters (grand total)
 */
async function executeOneCombo(
  cube: ManifestCube,
  measure: LlmSelection["measures"][number],
  filterTuples: FilterTuple[],
  comboLabel: string,
  traceId: string
): Promise<MeasureResult> {
  const buildWhere = (tuples: FilterTuple[]) =>
    tuples.length > 0 ? ` WHERE ( ${tuples.map((t) => t.member_unique_name).join(", ")} )` : "";

  // Identify date-hierarchy filters para el fallback progresivo.
  // Cubre todas las convenciones de nombre usadas en cubos SSAS:
  // [Fecha], [Date], [Período], [Periodos], [Tiempo], [FechaMatriculacion], etc.
  const isDateFilter = (t: FilterTuple) => {
    const n = normalize(t.dimension_mdx);
    return (
      n.startsWith("[fecha") ||
      n.startsWith("[date") ||
      n.startsWith("[period") ||
      n.startsWith("[tiempo") ||
      n.includes("fecha") ||
      n.includes("period") ||
      n.includes("date") ||
      n.includes("tiempo") ||
      n.includes("año") ||
      n.includes("mes") ||
      n.includes("anyo") ||
      n.includes("trimestre")
    );
  };

  const variantSets: FilterTuple[][] = [];
  if (filterTuples.length > 0) variantSets.push(filterTuples);

  const nonDate = filterTuples.filter((t) => !isDateFilter(t));
  if (nonDate.length !== filterTuples.length && nonDate.length > 0) variantSets.push(nonDate);

  variantSets.push([]); // final fallback: no WHERE

  let lastError: Error | undefined;

  for (const tuples of variantSets) {
    const mdx = `SELECT { ${measure.mdx_unique_name} } ON COLUMNS FROM [${cube.xmlaCubeName}]${buildWhere(tuples)}`;

    try {
      await debugLogger.log("ask", "mdx_attempt", {
        traceId,
        measure: measure.friendly_name,
        label: comboLabel,
        mdx
      });

      const result = await mdxBridgeService.executeMdx(mdx, cube.catalog);
      const rows = (result.rows as unknown[]) ?? [];
      const value = parseSsasNumber(extractScalarValue(rows));

      // Construir label descriptivo: indica si se aplicaron todos los filtros,
      // solo algunos (fallback parcial) o ninguno (fallback total).
      const requestedCount = filterTuples.length;
      const appliedCount   = tuples.length;
      let appliedLabel: string;
      if (appliedCount === requestedCount && requestedCount > 0) {
        appliedLabel = tuples.map((t) => `${t.dimension_friendly}="${t.value_caption}"`).join(", ");
      } else if (appliedCount > 0) {
        const appliedStr = tuples.map((t) => `${t.dimension_friendly}="${t.value_caption}"`).join(", ");
        appliedLabel = `${appliedStr} (⚠️ filtros de fecha omitidos por incompatibilidad MDX)`;
      } else {
        appliedLabel = requestedCount > 0
          ? `total general (⚠️ los filtros originales no pudieron aplicarse en este cubo)`
          : "sin filtros";
      }

      pLog("  ↳", GREEN, `MDX OK  valor=${value ?? "null"}`, `[${appliedLabel}]`);
      pLog("    ", DIM, "MDX", mdx.replace(/\s+/g, " ").slice(0, 160));

      await debugLogger.log("ask", "mdx_success", {
        traceId,
        measure: measure.friendly_name,
        label: appliedLabel,
        value,
        filters_applied: tuples.length
      });

      return {
        technical_name: measure.technical_name,
        friendly_name: measure.friendly_name,
        cube_name: cube.cubeName,
        mdx,
        value,
        catalog: cube.catalog,
        filter_combo: tuples,
        filter_label: appliedLabel
      };
    } catch (err) {
      lastError = err as Error;
      pLog("  ✗", RED, `MDX ERROR`, `[${comboLabel}] ${(err as Error).message.slice(0, 120)}`);
      await debugLogger.log("ask", "mdx_error", {
        traceId,
        measure: measure.friendly_name,
        label: comboLabel,
        error: (err as Error).message
      });
    }
  }

  if (lastError) throw lastError;

  return {
    technical_name: measure.technical_name,
    friendly_name: measure.friendly_name,
    cube_name: cube.cubeName,
    mdx: "",
    value: null,
    catalog: cube.catalog,
    filter_combo: [],
    filter_label: `${comboLabel} (error)`
  };
}

/**
 * Executes MDX for each filter combination (e.g. one query for Madrid, one for Valencia).
 * Returns all results — one per combination.
 */
async function executeMeasureQuery(
  cube: ManifestCube,
  measure: LlmSelection["measures"][number],
  filterGroups: ResolvedFilterGroup[],
  traceId: string
): Promise<MeasureResult[]> {
  const combinations = generateFilterCombinations(filterGroups);
  const results: MeasureResult[] = [];

  for (const combo of combinations) {
    const label =
      combo.length > 0
        ? combo.map((t) => `${t.dimension_friendly}="${t.value_caption}"`).join(", ")
        : "sin filtros";

    try {
      const result = await executeOneCombo(cube, measure, combo, label, traceId);
      results.push(result);
    } catch (err) {
      await debugLogger.log("ask", "combo_execution_error", {
        traceId,
        measure: measure.friendly_name,
        label,
        error: (err as Error).message
      });
    }
  }

  return results;
}

// ── Response Generation (delegated to responseAgent) ────────────────────────

async function generateNaturalResponse(
  question: string,
  results: MeasureResult[],
  selection: LlmSelection,
  unresolvedFilters: Array<{ hierarchy_mdx: string; friendly_name: string; values: string[] }>,
  filterExpansions: FilterExpansion[] = []
): Promise<string> {
  const ssasResults: responseAgent.SsasResult[] = results.map((r) => ({
    measure_name: r.friendly_name,
    value: r.value ?? "sin datos",
    dimensions: r.filter_combo.reduce(
      (acc, t) => ({ ...acc, [t.dimension_friendly]: t.value_caption }),
      {} as Record<string, string>
    )
  }));

  const appliedFilters: responseAgent.AppliedFilter[] = results
    .flatMap((r) => r.filter_combo)
    .reduce((acc: responseAgent.AppliedFilter[], t) => {
      const existing = acc.find((a) => a.friendly_name === t.dimension_friendly);
      if (existing) {
        if (!existing.values.includes(t.value_caption)) existing.values.push(t.value_caption);
      } else {
        acc.push({ friendly_name: t.dimension_friendly, values: [t.value_caption] });
      }
      return acc;
    }, []);

  return responseAgent.generate({
    originalQuestion: question,
    cubeName: selection.cube_name,
    results: ssasResults,
    appliedFilters,
    unresolvedFilters: unresolvedFilters.map((u) => ({
      friendly_name: u.friendly_name,
      values: u.values
    })),
    filterExpansions: filterExpansions.map((e) => ({
      original: e.original,
      expanded: e.expanded,
      friendly_name: e.friendly_name
    }))
  });
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

export async function runAskPipeline(
  userPrompt: string,
  options?: {
    traceId?: string;
    conversationHistory?: ConversationTurn[];
    /** Lista de cubos a los que el usuario tiene acceso. null = todos los cubos. */
    allowedCubes?: string[] | null;
  }
): Promise<AskResponsePayload> {
  const traceId = options?.traceId ?? randomUUID();
  const prompt = userPrompt.trim();
  if (!prompt) throw new Error("La pregunta no puede estar vacía.");

  const conversationHistory = options?.conversationHistory ?? [];
  const allowedCubes = options?.allowedCubes ?? null; // null = sin restricción (BYPASS_AUTH)

  await debugLogger.log("ask", "pipeline_start", {
    traceId,
    prompt,
    allowedCubes: allowedCubes ?? "all"
  });
  const t0 = Date.now();
  console.log(`\n${CYAN}${"─".repeat(70)}${RESET}`);
  pLog("❓", CYAN, "PREGUNTA", `"${prompt}"`);
  pLog("🔑", DIM, "traceId", traceId);

  // ── Detección temprana de preguntas de autodescripción ────────────────────
  // Se hace ANTES del intent extraction para no depender de si el LLM lo clasifica
  // como out_of_domain o meta_question.
  const promptNormEarly = normalize(prompt);
  const isSelfDescriptionEarly =
    /^(que eres|quien eres|que puedes|para que sirves|como funciona|que haces|eres un|describe.*sistema|explica.*sistema|cuéntame de ti|cuéntame sobre ti)/.test(promptNormEarly);

  if (isSelfDescriptionEarly) {
    const manifest0 = await catalogService.getManifest();
    const vis0 = allowedCubes === null
      ? manifest0.cubes
      : manifest0.cubes.filter(
          (c: ManifestCube) =>
            allowedCubes.includes(c.cubeName) ||
            allowedCubes.includes(c.catalog) ||
            allowedCubes.includes(c.xmlaCubeName)
        );
    const cubeNames0 = vis0.map((c: ManifestCube) => `"${c.catalog}"`).join(", ");
    return {
      question: prompt,
      answer: `Soy un asistente de análisis de datos especializado en el mercado de automoción español. Puedo responder preguntas sobre matriculaciones, ventas, cuotas de mercado, stock y otros indicadores del sector. Tengo acceso a los datos de los siguientes cubos: ${cubeNames0}. Puedes preguntarme, por ejemplo, "¿cuántas matriculaciones hubo en 2024?", "¿cuál es la cuota de mercado de Nissan?" o "¿qué vendió Madrid el año pasado?"`,
      data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  const manifest = await catalogService.getManifest();

  // ── Aplicar restricciones de acceso: construir el conjunto de cubos visibles ─
  // El API Launcher devuelve nombres como "Cubo Nissan" que coinciden con c.catalog o
  // c.xmlaCubeName, no con c.cubeName (ID sanitizado interno: "Cubo_Nissan_Cubo_Nissan").
  const isCubeVisible = (c: ManifestCube): boolean =>
    allowedCubes === null ||
    allowedCubes.includes(c.cubeName) ||
    allowedCubes.includes(c.catalog) ||
    allowedCubes.includes(c.xmlaCubeName);

  const visibleCubes = manifest.cubes.filter(isCubeVisible);

  if (allowedCubes !== null) {
    pLog("🔒", YELLOW, "Cubos permitidos (Launcher)", `[${allowedCubes.join(", ") || "ninguno"}]`);
    pLog("👁️ ", BLUE, "Cubos visibles", `${visibleCubes.length} de ${manifest.cubes.length}`);
  }

  // Sanear el historial de conversación: eliminar referencias a cubos que el usuario
  // ya no puede ver (permisos revocados o diferentes entre sesiones).
  const sanitizedHistory = conversationHistory.map((turn) => {
    if (turn.cube && !visibleCubes.some((c) => c.cubeName === turn.cube || c.catalog === turn.cube)) {
      return { ...turn, cube: null, measure: null };
    }
    return turn;
  });

  // El cubo anterior solo se usa como sticky bonus si está dentro de los visibles.
  const prevCubeName = [...sanitizedHistory].reverse().find((t) => t.cube)?.cube ?? null;

  if (visibleCubes.length === 0) {
    return {
      question: prompt,
      answer: "No tienes acceso a ningún cubo de datos. Contacta con el administrador para solicitar permisos.",
      data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
    };
  }

  // ── Pre-normalización de jergas del sector ───────────────────────────────────
  // Sustituye términos del glosario automotriz antes de enviar al intérprete.
  // Solo actúa sobre términos marcados como preNormalize:true (inequívocos).
  const jargonResult = normalizeJargon(prompt);
  const normalizedPrompt = jargonResult.normalized;
  if (jargonResult.substitutions.length > 0) {
    pLog("📖", YELLOW, "Jergas normalizadas",
      jargonResult.substitutions.map((s) => `"${s.from}" → "${s.to}"`).join(" | "));
    await debugLogger.log("ask", "jargon_normalized", {
      traceId,
      original: prompt,
      normalized: normalizedPrompt,
      substitutions: jargonResult.substitutions
    });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Step 1: Agent 1 — Interpreter: extract structured intent from the question ─
  pLog("🧠", MAGENTA, "Agent 1 (Intérprete): extrayendo intención...");
  // Pasar los nombres de los cubos visibles para que el intérprete use preferredCube
  // solo con cubos a los que este usuario tiene acceso real.
  const visibleCubeNames = visibleCubes.map((c) => c.catalog);
  const intent = await interpreterAgent.analyze(normalizedPrompt, sanitizedHistory, visibleCubeNames);
  await debugLogger.log("ask", "intent_extracted", { traceId, intent });

  // Use intent to detect meta-questions (more reliable than raw keyword matching)
  if (intent.isMetaQuestion) {
    const promptNorm = normalize(prompt);

    // 1) Si hay preferredCube, ir directamente a la descripción del cubo específico
    //    ANTES de cualquier otro chequeo para evitar falsos positivos en self-description.
    //    Ej: "que me puedes decir sobre el cubo de matriculaciones" → preferredCube="Matriculaciones"
    //    NO debe caer en isSelfDescription aunque empiece por "que" y contenga "puedes".

    // 2) Detect self-description questions ("¿qué eres?", "¿qué puedes hacer?", etc.)
    //    Solo aplica si NO hay un cubo específico mencionado (ni en preferredCube ni en el texto).
    const mentionsCube = promptNorm.includes("cubo") || promptNorm.includes("datos de") || promptNorm.includes("informacion de");
    const isSelfDescription =
      !intent.preferredCube &&
      !mentionsCube &&
      /^(que|quien|como|para que|cuál es tu|que tipo de|describe|explica|cuéntame sobre ti|cuéntame de ti)/.test(promptNorm) &&
      (promptNorm.includes("eres") || promptNorm.includes("puedes") || promptNorm.includes("haces") ||
       promptNorm.includes("funciona") || promptNorm.includes("sirves") || promptNorm.includes("sei"));

    if (isSelfDescription || (!intent.preferredCube && !mentionsCube && promptNorm.match(/^(que eres|quien eres|que puedes|para que sirves|como funciona)/))) {
      const cubeNames = visibleCubes.map((c) => `"${c.catalog}"`).join(", ");
      return {
        question: prompt,
        answer: `Soy un asistente de análisis de datos especializado en el mercado de automoción español. Puedo responder preguntas sobre matriculaciones, ventas, cuotas de mercado, stock y otros indicadores del sector. Tengo acceso a los datos de los siguientes cubos: ${cubeNames}. Puedes preguntarme cosas como "¿cuántas matriculaciones hubo en 2024?", "¿cuál es la cuota de mercado de Nissan?", o "¿qué vendió Madrid el año pasado?"`,
        data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
      };
    }

    // 2) Check if user is asking about a SPECIFIC cube (not just "list all cubes")
    const cubeEntityHint = intent.preferredCube ??
      intent.entities.find((e) => e.type === "other" || e.type === "product" || e.type === "brand")?.normalizedHint ??
      intent.entities[0]?.rawValue;

    if (cubeEntityHint) {
      const normHint = normalize(cubeEntityHint);
      const targetCube = visibleCubes.find(
        (c) =>
          normalize(c.cubeName).includes(normHint) ||
          normalize(c.catalog).includes(normHint) ||
          normHint.includes(normalize(c.cubeName))
      );

      if (targetCube) {
        const measures = targetCube.members.filter((m) => m.type === "measure").slice(0, 20);
        const dims = [...new Set(
          targetCube.members
            .filter((m) => m.type === "dimension")
            .map((m) => m.friendlyName)
            .slice(0, 10)
        )];
        const measureNames = measures.map((m) => m.friendlyName).join(", ");
        const dimNames = dims.join(", ");
        const totalMeasures = targetCube.members.filter((m) => m.type === "measure").length;

        const description =
          `El cubo "${targetCube.catalog}" contiene ${totalMeasures} medidas. ` +
          (measureNames ? `Las principales son: ${measureNames}. ` : "") +
          (dimNames ? `Puedes filtrar la información por: ${dimNames}.` : "");

        return {
          question: prompt,
          answer: description,
          data: { value: null, cube: targetCube.cubeName, measure: null, mdx: null, results: [], selection: {} }
        };
      }
    }

    // 3) Generic: list all accessible cubes
    const cubeList = visibleCubes.map((c) => `"${c.catalog}"`).join(", ");
    return {
      question: prompt,
      answer: `Tienes acceso a los siguientes cubos de datos: ${cubeList}. Puedes preguntarme sobre cualquiera de ellos.`,
      data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
    };
  }

  // Detect questions outside the analytics domain
  // La presencia de entidades de marca/producto o tiempo son señales fuertes de que la
  // pregunta SÍ está dentro del dominio, aunque el intérprete no identifique métricas explícitas.
  const hasAnalyticsEntities =
    intent.entities.some((e) => ["brand", "product", "location", "segment"].includes(e.type)) ||
    !!intent.timeFilters?.year ||
    !!intent.timeFilters?.month ||
    !!intent.preferredCube;

  const isOutOfDomain =
    (intent as any).is_out_of_domain === true ||
    intent.domain === "out_of_domain" ||
    // Fallback solo si NO hay entidades de analytics Y no hay métricas Y no es meta-pregunta
    (intent.primaryMetrics.length === 0 && !intent.isMetaQuestion && intent.domain === "general" && !hasAnalyticsEntities);

  if (isOutOfDomain) {
    return {
      question: prompt,
      answer: "Solo puedo responder preguntas sobre datos analíticos: matriculaciones, ventas, stock, cuotas de mercado y datos disponibles en los cubos OLAP. Por favor reformula tu pregunta dentro de ese dominio.",
      data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
    };
  }

  // ── Step 2: Pre-filter candidate cubes using intent signals (improved) ──────
  const candidateCubes = prefilterCubesByIntent(visibleCubes, intent, prompt, 5, prevCubeName);
  await debugLogger.log("ask", "candidate_cubes", {
    traceId,
    cubes: candidateCubes.map((c) => c.cubeName),
    prevCubeName,
    intentDomain: intent.domain
  });
  if (prevCubeName) {
    pLog("🔄", CYAN, "Contexto conversación", `cubo anterior: "${prevCubeName}"`);
  }
  pLog("📦", BLUE, "Candidatos", candidateCubes.map((c) => c.cubeName).join(" | "));

  // If the user asked about a specific brand/cube that isn't in their visible cubes, warn them
  if (intent.preferredCube) {
    const normPref = normalize(intent.preferredCube);
    const matchFound = candidateCubes.some(
      (c) =>
        normalize(c.cubeName).includes(normPref) ||
        normalize(c.catalog).includes(normPref) ||
        normPref.includes(normalize(c.cubeName))
    );
    if (!matchFound) {
      const available = visibleCubes.map((c) => `"${c.catalog}"`).join(", ");
      return {
        question: prompt,
        answer: `No tengo acceso al cubo de "${intent.preferredCube}" con tu suscripción actual. Los cubos disponibles para ti son: ${available}.`,
        data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
      };
    }
  }

  // ── Guarda de entidades de marca: solo bloquear si NO hay ningún cubo visible
  // que pueda contener datos de esa marca, ya sea por nombre de cubo O por tener
  // un cubo de mercado general (Matriculaciones, Market, etc.) donde la marca
  // aparece como filtro de dimensión.
  // IMPORTANTE: No bloquear si hay un cubo de mercado general accesible — ese cubo
  // suele tener dimensión [Marca] con todas las marcas del mercado como valores.
  const brandEntities = intent.entities.filter((e) => e.type === "brand" || e.type === "product");
  if (brandEntities.length > 0) {
    // ¿Hay algún cubo genérico de mercado entre los visibles?
    const hasMarketCube = visibleCubes.some((c) => {
      const n = normalize(c.cubeName + " " + c.catalog);
      return (
        n.includes("matriculacion") ||
        n.includes("market") ||
        n.includes("mercado")
      );
    });

    // ¿Hay algún cubo de marca propio entre los visibles?
    // Se detecta dinámicamente: cubo no genérico de mercado que tiene medidas
    // cuyo nombre incluye el nombre del cubo (ej: "Matriculaciones Nissan" en "Cubo Nissan").
    const hasOwnBrandCube = visibleCubes.some((c) => {
      const cNorm = normalize(c.catalog).replace(/cubo\s*/i, "").trim();
      const cIsGeneric = normalize(c.cubeName + c.catalog).includes("matriculacion") ||
                         normalize(c.cubeName + c.catalog).includes("market") ||
                         normalize(c.cubeName + c.catalog).includes("mercado");
      return (
        cNorm.length > 2 &&
        !cIsGeneric &&
        c.members.some((m) => m.type === "measure" && normalize(m.friendlyName).includes(cNorm))
      );
    });

    for (const entity of brandEntities) {
      const normEntity = normalize(entity.normalizedHint ?? entity.rawValue);
      // ¿El nombre de la entidad coincide con un cubo visible?
      const brandCubeFound = visibleCubes.some(
        (c) =>
          normalize(c.cubeName).includes(normEntity) ||
          normalize(c.catalog).includes(normEntity)
      );

      // Solo bloqueamos si:
      // 1. No hay cubo named con esa marca
      // 2. No hay cubo de mercado general accesible (que tendría la marca como dimensión)
      // 3. No hay ningún cubo de marca propio (que también contiene datos del mercado total)
      if (!brandCubeFound && !hasMarketCube && !hasOwnBrandCube) {
        const available = visibleCubes.map((c) => `"${c.catalog}"`).join(", ");
        return {
          question: prompt,
          answer: `No tengo acceso a datos específicos de "${entity.rawValue}" con tu suscripción. Los cubos disponibles para ti son: ${available}.`,
          data: { value: null, cube: null, measure: null, mdx: null, results: [], selection: {} }
        };
      }
    }
  }

  // ── Step 3: Build catalog context enriched with SSAS hierarchy paths ─────────
  pLog("🏗️ ", BLUE, "Construyendo catálogo con jerarquías SSAS...");
  const catalogContext = await buildCatalogContextWithHierarchies(candidateCubes, prompt);

  // ── Step 4: Agent 2 — Mapper: map intent to exact catalog elements ───────────
  pLog("🗺️ ", MAGENTA, "Agent 2 (Mapeador): seleccionando cubo, medidas y filtros...");
  let selection: LlmSelection;
  try {
    selection = await mapperAgent.map(intent, catalogContext, sanitizedHistory);
    selection.filters = normalizeFilters(selection.filters as unknown[]);
  } catch (err) {
    await debugLogger.log("ask", "mapper_agent_error", {
      traceId,
      error: (err as Error).message
    });
    throw err;
  }
  // ── GUARDIA DE FILTROS: eliminar filtros claramente inventados por el mapper ──
  // CRITERIO CONSERVADOR: solo se poda un filtro cuando hay CERTEZA de que el usuario
  // NO lo pidió. El mapper puede detectar entidades que el intérprete no capturó
  // explícitamente (ej: "en 2024" → el mapper infiere el año aunque timeFilters.year sea null).
  // En caso de duda, se deja pasar el filtro — es mejor un falso positivo que perder datos.

  const hasIntentYear    = Boolean(intent.timeFilters?.year);
  const hasIntentMonth   = Boolean(intent.timeFilters?.month);
  const hasIntentEntities = intent.entities.length > 0;

  // Extraer tokens de la pregunta normalizada para comprobar si el filtro tiene respaldo léxico
  const questionTokens = extractTokens(normalizedPrompt);

  const originalFilterCount = selection.filters.length;
  selection.filters = selection.filters.filter((f) => {
    // ─ Filtro de AÑO ──────────────────────────────────────────────────────────
    if (f.type === "year") {
      if (hasIntentYear) return true; // intérprete lo detectó → ok
      // El intérprete no lo detectó. Comprobamos si el año aparece en el texto original.
      const yearInQuestion = f.values.some((v) => normalizedPrompt.includes(v));
      return yearInQuestion;
    }

    // ─ Filtro de MES ──────────────────────────────────────────────────────────
    if (f.type === "month") {
      if (hasIntentMonth) return true;
      const monthInQuestion = f.values.some((v) =>
        normalize(normalizedPrompt).includes(normalize(v))
      );
      return monthInQuestion;
    }

    // ─ Filtro de DIMENSIÓN ────────────────────────────────────────────────────
    if (f.type === "dimension") {
      if (hasIntentEntities) return true; // el intérprete extrajo entidades → ok
      // Sin entidades declaradas: solo podar si NINGUNO de los valores del filtro
      // aparece con algún token de la pregunta (ej. mapper inventó "Madrid" sin que
      // el usuario lo dijera).
      const valueInQuestion = f.values.some((v) => {
        const vTokens = extractTokens(v);
        return vTokens.some((vt) => questionTokens.includes(vt));
      });
      return valueInQuestion;
    }

    return true;
  });

  if (selection.filters.length < originalFilterCount) {
    pLog("⚠️", YELLOW, "Filtros inventados eliminados",
      `${originalFilterCount - selection.filters.length} filtro(s) sin respaldo en la pregunta fueron descartados`);
    await debugLogger.log("ask", "filters_pruned", {
      traceId,
      removed: originalFilterCount - selection.filters.length,
      remaining: selection.filters.length,
      hadYear: hasIntentYear,
      hadMonth: hasIntentMonth,
      hadEntities: hasIntentEntities
    });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  await debugLogger.log("ask", "llm_selection", { traceId, selection });
  pLog("✅", GREEN, "Mapeador seleccionó cubo", `"${selection.cube_name}"`);
  for (const m of selection.measures) {
    pLog("  📊", GREEN, `Medida`, `${m.mdx_unique_name}  (${m.friendly_name})`);
  }
  for (const f of selection.filters ?? []) {
    pLog("  🔍", YELLOW, `Filtro ${f.type}`, `${f.hierarchy_mdx}  →  ${f.values.join(", ")}`);
  }
  if (selection.reasoning) {
    pLog("  💬", DIM, "Razonamiento", selection.reasoning.slice(0, 120));
  }

  // ── Step 5: Resolve cube in manifest (solo entre los cubos visibles del usuario) ─
  let selectedCube: ManifestCube;
  try {
    selectedCube = resolveCube({ ...manifest, cubes: visibleCubes }, selection.cube_name);
  } catch (err) {
    await debugLogger.log("ask", "cube_not_found_retrying", {
      traceId,
      selected: selection.cube_name,
      error: (err as Error).message
    });
    // Retry with expanded context (all visible cubes)
    pLog("⚠️ ", YELLOW, "Cubo no encontrado, reintentando con catálogo completo...");
    const expandedContext = await buildCatalogContextWithHierarchies(visibleCubes.slice(0, 8), prompt);
    const retryMapping = await mapperAgent.map(intent, expandedContext, sanitizedHistory);
    selectedCube = resolveCube({ ...manifest, cubes: visibleCubes }, retryMapping.cube_name);
    selection.cube_name = retryMapping.cube_name;
    selection.measures = retryMapping.measures;
    selection.filters = normalizeFilters(retryMapping.filters as unknown[]);
    selection.reasoning = retryMapping.reasoning;
  }

  // ── Step 6: Validate + normalize measures from manifest ───────────────────
  const validatedMeasures = selection.measures
    .map((m) => {
      const cubeMeasures = selectedCube.members.filter((mb) => mb.type === "measure");

      // 1) Coincidencia exacta por cubeMember o mdxUniqueName
      let member = cubeMeasures.find(
        (mb) => mb.cubeMember === m.technical_name || mb.mdxUniqueName === m.mdx_unique_name
      );

      // 2) Coincidencia fuzzy por friendlyName (normalizada, longitud > 3)
      if (!member && m.friendly_name && normalize(m.friendly_name).length > 3) {
        member = cubeMeasures.find(
          (mb) =>
            normalize(mb.friendlyName).includes(normalize(m.friendly_name)) ||
            normalize(m.friendly_name).includes(normalize(mb.friendlyName))
        );
      }

      // 3) Coincidencia por token overlap: al menos 2 tokens en común
      if (!member && m.friendly_name) {
        const mTokens = extractTokens(m.friendly_name);
        if (mTokens.length >= 2) {
          const tokenScored = cubeMeasures
            .map((mb) => ({ mb, score: scoreMatch(mb.friendlyName, mTokens) }))
            .filter(({ score }) => score >= 2)
            .sort((a, b) => b.score - a.score);
          if (tokenScored.length > 0) member = tokenScored[0].mb;
        }
      }

      // 4) Si el mdxUniqueName del mapper parece válido (tiene la forma [Measures].[X]),
      //    confiar en él directamente aunque no esté en el catálogo local.
      //    El fallback MDX intentará la query y si falla pasará al siguiente variant.
      if (!member && m.mdx_unique_name?.startsWith("[Measures].")) {
        console.warn(
          `[askController] Measure "${m.friendly_name}" not in local catalog — ` +
          `trusting mapper MDX "${m.mdx_unique_name}" directly.`
        );
        return { ...m }; // usar tal cual, sin sobreescribir
      }

      if (!member) {
        console.warn(
          `[askController] Measure "${m.friendly_name}" (${m.technical_name}) not found in cube ${selectedCube.cubeName}, skipping.`
        );
        return null;
      }

      return {
        ...m,
        technical_name: member.cubeMember,
        mdx_unique_name: member.mdxUniqueName,
        friendly_name: member.friendlyName
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (!validatedMeasures.length) {
    // Último recurso: si el mapper produjo medidas pero ninguna validó,
    // usar la primera medida del cubo como fallback genérico.
    const fallbackMeasure = selectedCube.members.find((mb) => mb.type === "measure");
    if (fallbackMeasure) {
      console.warn(
        `[askController] No validated measures — falling back to first cube measure: "${fallbackMeasure.friendlyName}"`
      );
      validatedMeasures.push({
        technical_name: fallbackMeasure.cubeMember,
        mdx_unique_name: fallbackMeasure.mdxUniqueName,
        friendly_name: fallbackMeasure.friendlyName
      } as LlmSelection["measures"][number]);
    } else {
      throw new Error(
        `Ninguna de las medidas seleccionadas (${selection.measures.map((m) => m.friendly_name).join(", ")}) ` +
          `existe en el cubo "${selectedCube.cubeName}". Intenta reformular la pregunta.`
      );
    }
  }

  // ── Step 7: Resolve filter members via XMLA DISCOVER (multi-value aware) ──
  const { groups: resolvedFilterGroups, unresolved: unresolvedFilters, expansions: filterExpansions } =
    await resolveFilters(selectedCube, selection.filters, traceId);
  await debugLogger.log("ask", "resolved_filters", { traceId, groups: resolvedFilterGroups, unresolved: unresolvedFilters });
  pLog("🔗", BLUE, "Filtros resueltos en SSAS");
  for (const g of resolvedFilterGroups) {
    const members = g.members.map((m) => `${m.value_caption} → ${m.member_unique_name}`).join(" | ");
    pLog("  ✓", GREEN, g.hierarchy_friendly, members);
  }
  if (unresolvedFilters.length > 0) {
    for (const u of unresolvedFilters) {
      pLog("  ✗", RED, `NO ENCONTRADO: ${u.friendly_name}`, u.values.join(", "));
    }
  }

  // ── Step 8: Execute MDX — one query per filter combination ────────────────
  const allResults: MeasureResult[] = [];
  for (const measure of validatedMeasures) {
    try {
      const measureResults = await executeMeasureQuery(
        selectedCube,
        measure,
        resolvedFilterGroups,
        traceId
      );
      allResults.push(...measureResults);
    } catch (err) {
      await debugLogger.log("ask", "measure_execution_error", {
        traceId,
        measure: measure.friendly_name,
        error: (err as Error).message
      });
    }
  }

  if (!allResults.length) {
    throw new Error(
      `No se pudo ejecutar la consulta MDX para las medidas seleccionadas en "${selectedCube.cubeName}".`
    );
  }

  // ── Step 9: Agent 3 — Response: format final answer ────────────────────────
  pLog("✍️ ", MAGENTA, "Agent 3 (Formateador): generando respuesta natural...");
  const answer = await generateNaturalResponse(prompt, allResults, selection, unresolvedFilters, filterExpansions);
  const primary = allResults[0];

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  pLog("💬", GREEN, "RESPUESTA FINAL", `\n${answer}`);
  pLog("⏱️ ", CYAN, `Completado en ${elapsed}s`, `— ${allResults.length} resultado(s)`);
  console.log(`${CYAN}${"─".repeat(70)}${RESET}\n`);

  await debugLogger.log("ask", "pipeline_success", {
    traceId,
    cube: selectedCube.cubeName,
    elapsed_ms: Date.now() - t0,
    answer: answer.slice(0, 300),
    results: allResults.map((r) => ({ measure: r.friendly_name, value: r.value, label: r.filter_label }))
  });

  return {
    question: prompt,
    answer,
    data: {
      value: primary?.value ?? null,
      cube: selectedCube.cubeName,
      measure: primary?.friendly_name ?? null,
      mdx: primary?.mdx ?? null,
      results: allResults,
      selection
    }
  };
}

export async function askController(req: Request, res: Response): Promise<Response> {
  try {
    const userPrompt = String(req.body?.question ?? req.body?.user_prompt ?? "").trim();
    if (!userPrompt) {
      return res.status(400).json({ error: "El campo 'question' es requerido." });
    }
    const traceId = randomUUID();
    const payload = await runAskPipeline(userPrompt, {
      traceId,
      allowedCubes: req.allowedCubes ?? null
    });
    return res.status(200).json(payload);
  } catch (error) {
    pLog("💥", RED, "PIPELINE ERROR", (error as Error).message);
    console.log(`${RED}${"─".repeat(70)}${RESET}\n`);
    await debugLogger.log("ask", "pipeline_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "ASK_PIPELINE_ERROR",
      error: (error as Error).message
    });
  }
}
