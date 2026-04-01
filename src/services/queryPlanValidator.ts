/**
 * Validación y corrección determinística del plan de consulta (cubo + medidas)
 * después del mapper LLM.
 *
 * 1) preferredCube: alinear con el cubo explícito del usuario si el mapper eligió otro.
 * 2) Mercado genérico: si el pre-filtro recomendó cubo general y el mapper eligió cubo de marca.
 */

import type { QueryIntent, CatalogMapping, MappedMeasure } from "../agents/types";
import type { XmlaManifestCube, XmlaManifestMember } from "./catalogService";

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

/** Misma noción que en askController.prefilterCubesByIntent */
function isGenericMarketCube(cube: XmlaManifestCube): boolean {
  const n = normalize(cube.cubeName + " " + cube.catalog);
  return n.includes("matriculacion") || n.includes("market") || n.includes("mercado");
}

/** Cubo “de marca” con medidas que incluyen el nombre del catálogo */
function isBrandedCube(cube: XmlaManifestCube): boolean {
  if (isGenericMarketCube(cube)) return false;
  const catalogNorm = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
  if (catalogNorm.length <= 2) return false;
  return cube.members.some(
    (m) => m.type === "measure" && normalize(m.friendlyName).includes(catalogNorm)
  );
}

/**
 * Resuelve el cubo elegido por el mapper solo contra la lista permitida.
 * No hace fallback al primer cubo (devuelve null si no hay coincidencia usable).
 */
export function tryResolveCubeInList(
  cubes: XmlaManifestCube[],
  selectedName: string
): XmlaManifestCube | null {
  if (!cubes.length || !selectedName?.trim()) return null;

  const exact = cubes.find((c) => c.cubeName === selectedName);
  if (exact) return exact;

  const normSelected = normalize(selectedName);
  const partial = cubes.find(
    (c) =>
      normalize(c.cubeName).includes(normSelected) ||
      normSelected.includes(normalize(c.cubeName)) ||
      normalize(c.catalog).includes(normSelected) ||
      normSelected.includes(normalize(c.catalog))
  );
  if (partial) return partial;

  const tokens = extractTokens(selectedName);
  if (tokens.length === 0) return null;

  const scored = cubes
    .map((c) => ({
      cube: c,
      score: scoreMatch(`${c.cubeName} ${c.catalog}`, tokens)
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score > 0) return best.cube;

  return null;
}

/** Cubo visible que mejor coincide con preferredCube del intérprete */
export function findCubeByPreferredHint(
  visibleCubes: XmlaManifestCube[],
  preferred: string
): XmlaManifestCube | null {
  const norm = normalize(preferred.trim());
  if (!norm) return null;

  const exact = visibleCubes.find(
    (c) =>
      normalize(c.cubeName) === norm ||
      normalize(c.catalog) === norm ||
      normalize(c.xmlaCubeName) === norm
  );
  if (exact) return exact;

  return (
    visibleCubes.find(
      (c) =>
        normalize(c.cubeName).includes(norm) ||
        normalize(c.catalog).includes(norm) ||
        normalize(c.xmlaCubeName).includes(norm) ||
        norm.includes(normalize(c.cubeName)) ||
        norm.includes(normalize(c.catalog))
    ) ?? null
  );
}

function toMappedMeasure(m: XmlaManifestMember): MappedMeasure {
  return {
    technical_name: m.cubeMember,
    mdx_unique_name: m.mdxUniqueName,
    friendly_name: m.friendlyName
  };
}

/**
 * Medidas alineadas con la intención; penaliza sufijos de marca (consulta mercado genérico).
 */
function remapMeasuresForGenericMarket(
  cube: XmlaManifestCube,
  intent: QueryIntent,
  previousCount: number
): MappedMeasure[] {
  const measures = cube.members.filter((m) => m.type === "measure");
  if (!measures.length) return [];

  const catalogNorm = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
  const metricTokens = intent.primaryMetrics.flatMap((pm) => extractTokens(pm));

  const scored = measures
    .map((m) => {
      let score = 0;
      const fn = normalize(m.friendlyName);
      for (const pm of intent.primaryMetrics) {
        const n = normalize(pm);
        if (n.length > 2 && (fn.includes(n) || n.includes(fn))) score += 15;
      }
      score += scoreMatch(m.friendlyName, metricTokens);
      if (catalogNorm.length > 2 && fn.includes(catalogNorm)) score -= 10;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  const n = Math.max(1, Math.min(previousCount || 1, 3, scored.length));
  const picked = scored.slice(0, n).map(({ m }) => toMappedMeasure(m));

  if (picked.length) return picked;

  const fallback = measures[0];
  return fallback ? [toMappedMeasure(fallback)] : [];
}

/**
 * Medidas cuando el usuario pidió un cubo concreto (p. ej. marca): bonificar medidas con sufijo de marca.
 */
function remapMeasuresForPreferredCube(
  cube: XmlaManifestCube,
  intent: QueryIntent,
  previousCount: number
): MappedMeasure[] {
  const measures = cube.members.filter((m) => m.type === "measure");
  if (!measures.length) return [];

  const catalogNorm = normalize(cube.catalog).replace(/cubo\s*/i, "").trim();
  const metricTokens = intent.primaryMetrics.flatMap((pm) => extractTokens(pm));
  const hasBrandedMeasures =
    catalogNorm.length > 2 &&
    measures.some((m) => normalize(m.friendlyName).includes(catalogNorm));

  const scored = measures
    .map((m) => {
      let score = 0;
      const fn = normalize(m.friendlyName);
      for (const pm of intent.primaryMetrics) {
        const n = normalize(pm);
        if (n.length > 2 && (fn.includes(n) || n.includes(fn))) score += 15;
      }
      score += scoreMatch(m.friendlyName, metricTokens);
      if (hasBrandedMeasures && catalogNorm.length > 2 && fn.includes(catalogNorm)) score += 12;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  const n = Math.max(1, Math.min(previousCount || 1, 3, scored.length));
  const picked = scored.slice(0, n).map(({ m }) => toMappedMeasure(m));
  if (picked.length) return picked;

  const fallback = measures[0];
  return fallback ? [toMappedMeasure(fallback)] : [];
}

export type QueryPlanValidationResult = {
  selection: CatalogMapping;
  cubeCorrected: boolean;
  correctionReason: "preferred_cube" | "generic_market" | null;
  corrections: string[];
  fromCubeName: string | null;
  toCubeName: string | null;
};

type ValidateParams = {
  selection: CatalogMapping;
  intent: QueryIntent;
  visibleCubes: XmlaManifestCube[];
  recommendedCubeName: string | null;
};

function passThrough(selection: CatalogMapping, from: string | null): QueryPlanValidationResult {
  return {
    selection,
    cubeCorrected: false,
    correctionReason: null,
    corrections: [],
    fromCubeName: from,
    toCubeName: null
  };
}

function tryCorrectPreferredCube(params: ValidateParams): QueryPlanValidationResult | null {
  const { selection, intent, visibleCubes } = params;
  const pref = intent.preferredCube?.trim();
  if (!pref) return null;

  const targetCube = findCubeByPreferredHint(visibleCubes, pref);
  if (!targetCube) return null;

  const resolvedMapper = tryResolveCubeInList(visibleCubes, selection.cube_name);
  if (!resolvedMapper || resolvedMapper.cubeName === targetCube.cubeName) {
    return null;
  }

  const newMeasures = remapMeasuresForPreferredCube(
    targetCube,
    intent,
    selection.measures?.length ?? 1
  );
  const suffix =
    " [Corrección automática: cubo alineado con el conjunto de datos indicado por el usuario.]";
  const corrected: CatalogMapping = {
    ...selection,
    cube_name: targetCube.cubeName,
    measures: newMeasures.length ? newMeasures : selection.measures,
    reasoning: (selection.reasoning ?? "") + suffix
  };

  return {
    selection: corrected,
    cubeCorrected: true,
    correctionReason: "preferred_cube",
    corrections: [
      `Cubo del mapper "${resolvedMapper.cubeName}" sustituido por "${targetCube.cubeName}" (preferredCube="${pref}").`
    ],
    fromCubeName: resolvedMapper.cubeName,
    toCubeName: targetCube.cubeName
  };
}

function tryCorrectGenericMarket(params: ValidateParams): QueryPlanValidationResult {
  const { selection, intent, visibleCubes, recommendedCubeName } = params;

  const hasBrandEntity = intent.entities.some((e) => e.type === "brand" || e.type === "product");
  const isGenericMarketQuery = !hasBrandEntity && !intent.preferredCube;

  if (!isGenericMarketQuery || !recommendedCubeName) {
    return passThrough(selection, null);
  }

  const resolvedMapper = tryResolveCubeInList(visibleCubes, selection.cube_name);
  if (!resolvedMapper) {
    return passThrough(selection, null);
  }

  if (resolvedMapper.cubeName === recommendedCubeName) {
    return passThrough(selection, resolvedMapper.cubeName);
  }

  const targetCube = visibleCubes.find((c) => c.cubeName === recommendedCubeName);
  if (!targetCube || !isGenericMarketCube(targetCube)) {
    return passThrough(selection, resolvedMapper.cubeName);
  }

  if (!isBrandedCube(resolvedMapper)) {
    return passThrough(selection, resolvedMapper.cubeName);
  }

  const newMeasures = remapMeasuresForGenericMarket(
    targetCube,
    intent,
    selection.measures?.length ?? 1
  );

  const suffix =
    " [Corrección automática: consulta genérica de mercado enrutada al cubo recomendado por el sistema.]";
  const corrected: CatalogMapping = {
    ...selection,
    cube_name: targetCube.cubeName,
    measures: newMeasures.length ? newMeasures : selection.measures,
    reasoning: (selection.reasoning ?? "") + suffix
  };

  return {
    selection: corrected,
    cubeCorrected: true,
    correctionReason: "generic_market",
    corrections: [
      `Cubo del mapper "${resolvedMapper.cubeName}" sustituido por "${targetCube.cubeName}" (mercado genérico).`
    ],
    fromCubeName: resolvedMapper.cubeName,
    toCubeName: targetCube.cubeName
  };
}

/**
 * Aplica primero la alineación con preferredCube; si no aplica, la regla de mercado genérico.
 */
export function validateAndCorrectQueryPlan(params: ValidateParams): QueryPlanValidationResult {
  const preferred = tryCorrectPreferredCube(params);
  if (preferred) return preferred;

  return tryCorrectGenericMarket(params);
}
