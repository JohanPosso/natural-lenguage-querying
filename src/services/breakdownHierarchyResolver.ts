/**
 * Resolución dinámica de jerarquía OLAP para desglose (ROWS), sin rutas MDX quemadas.
 * Usa dbo.olap_hierarchies (sincronizado desde SSAS por cubo/catálogo) y solo cubos
 * que el pipeline ya eligió — alineado con los permisos del usuario (visibleCubes).
 */

import type { HierarchyInfo, XmlaManifestCube } from "./catalogService";
import { catalogService } from "./catalogService";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Jerarquías que no sirven para desglose de negocio (ROWS) */
function shouldSkipHierarchy(hierarchyUniqueName: string): boolean {
  const u = hierarchyUniqueName.toUpperCase();
  if (u.includes("[MEASURES]")) return true;
  if (/\.\[D[IÍ]A\]/i.test(hierarchyUniqueName)) return true;
  if (/\.\[SEMANA\]/i.test(hierarchyUniqueName)) return true;
  return false;
}

/** Solo [Measures]: ocultar en listados de contexto para intérprete/mapper. */
export function shouldHideHierarchyInPrompt(hierarchyUniqueName: string): boolean {
  return hierarchyUniqueName.toUpperCase().includes("[MEASURES]");
}

/**
 * Términos de búsqueda según la dimensión semántica del intérprete (sin MDX fijo).
 * Cada instalación puede llamar distinto a la jerarquía (ej. [Fabricante].[Fabricante] vs [Marca].[Marca]).
 */
function searchTermsForSemantic(breakdownSemantic: string): string[] {
  const n = normalize(breakdownSemantic);

  if (n.includes("fabric") || n.includes("marca") || n.includes("make") || n.includes("brand")) {
    return ["fabricante", "marca", "make", "manufacturer", "oem", "brand", "manuf"];
  }
  if (n.includes("año") || n.includes("ano") || n.includes("year") || n === "fecha" || n.includes("periodo")) {
    return ["año", "year", "fecha", "periodo", "ano", "date", "time"];
  }
  if (n.includes("mes") || n.includes("month")) {
    return ["mes", "month", "mensual"];
  }
  if (n.includes("provincia") || n.includes("territorio")) {
    return ["provincia", "territorio", "region", "comunidad", "ccaa"];
  }
  if (n.includes("segmento") || n.includes("clasificacion") || n.includes("categoria")) {
    return ["segmento", "clasificacion", "categoria", "producto", "rgv"];
  }
  if (n.includes("region") || n.includes("comunidad")) {
    return ["comunidad", "region", "autonoma", "ccaa"];
  }
  if (n.includes("canal")) {
    return ["canal", "channel", "venta"];
  }

  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  return words.length ? words : [n];
}

/** Escapa `]` dentro de un identificador entre corchetes MDX. */
function escapeMdxBracketedSegment(name: string): string {
  return name.replace(/\]/g, "]]");
}

/**
 * Nivel hoja alineado con visores SSAS/RedRadix: { [Dim].[Hier].[Nivel].Members }.
 * Sin caption en catálogo, cae a .Members sobre la jerarquía (comportamiento anterior).
 */
function buildRowsAxisMdxSet(h: HierarchyInfo): string {
  const cap = h.hierarchyCaption.trim();
  if (!cap) return `{ ${h.hierarchyUniqueName}.Members }`;
  const esc = escapeMdxBracketedSegment(cap);
  return `{ ${h.hierarchyUniqueName}.[${esc}].Members }`;
}

/** Prefijo MDX hasta el nivel hoja (sin &.&[miembro]) para filter_combo / drill. */
function buildLeafMemberPathPrefix(h: HierarchyInfo): string {
  const cap = h.hierarchyCaption.trim();
  if (!cap) return h.hierarchyUniqueName;
  const esc = escapeMdxBracketedSegment(cap);
  return `${h.hierarchyUniqueName}.[${esc}]`;
}

/**
 * Desempate cuando varias jerarquías matchean "fabricante/marca":
 * preferir caption exacto "Fabricante" y penalizar variantes tipo "Fabricante Vehículo Base".
 */
function fabricanteMarcaTieBreak(h: HierarchyInfo, terms: string[]): number {
  if (!terms.some((t) => t === "fabricante" || t === "marca")) return 0;
  const cap = normalize(h.hierarchyCaption);
  const hun = normalize(h.hierarchyUniqueName);
  let b = 0;
  if (cap === "fabricante") b += 45;
  if (cap.includes("vehiculo") || cap.includes("vehículo") || cap.includes("base")) b -= 40;
  if (hun.includes("vehiculo") || hun.includes("vehículo") || hun.includes("vehiculo base")) b -= 25;
  return b;
}

function scoreHierarchyAgainstTerms(h: HierarchyInfo, terms: string[]): number {
  const blob = normalize(
    `${h.hierarchyCaption} ${h.hierarchyUniqueName} ${h.dimensionUniqueName}`
  );
  let score = 0;
  for (const t of terms) {
    if (t.length < 2) continue;
    if (blob === t) score += 100;
    else if (blob.includes(t)) score += 25;
    if (normalize(h.hierarchyCaption).includes(t)) score += 20;
    if (normalize(h.hierarchyUniqueName).includes(t)) score += 15;
  }
  score += fabricanteMarcaTieBreak(h, terms);
  return score;
}

function scoreManifestDimension(
  mdxUniqueName: string,
  friendlyName: string,
  terms: string[]
): number {
  const blob = normalize(`${mdxUniqueName} ${friendlyName}`);
  let score = 0;
  for (const t of terms) {
    if (t.length < 2) continue;
    if (blob.includes(t)) score += 20;
  }
  return score;
}

export type BreakdownHierarchyResolution = {
  hierarchyUniqueName: string;
  /** Set ON ROWS (nivel hoja), p. ej. { [Fabricante].[Fabricante].[Fabricante].Members } */
  rowsAxisMdxSet: string;
  /** Prefijo para miembro hoja en filter_combo, p. ej. [Fabricante].[Fabricante].[Fabricante] */
  leafMemberPathPrefix: string;
  source: "sql_catalog" | "manifest_fallback";
  score: number;
};

/**
 * Elige la jerarquía MDX del cubo que mejor coincide con la dimensión semántica pedida.
 */
export async function resolveBreakdownHierarchySemantic(
  breakdownSemantic: string,
  cube: XmlaManifestCube
): Promise<BreakdownHierarchyResolution | null> {
  const terms = searchTermsForSemantic(breakdownSemantic);
  if (!terms.length) return null;

  const sqlHiers = await catalogService.getHierarchiesForCube(cube.catalog, cube.xmlaCubeName);

  let best: { h: HierarchyInfo; score: number } | null = null;
  for (const h of sqlHiers) {
    if (shouldSkipHierarchy(h.hierarchyUniqueName)) continue;
    const score = scoreHierarchyAgainstTerms(h, terms);
    if (!best || score > best.score) best = { h, score };
  }

  if (best && best.score > 0) {
    return {
      hierarchyUniqueName: best.h.hierarchyUniqueName,
      rowsAxisMdxSet: buildRowsAxisMdxSet(best.h),
      leafMemberPathPrefix: buildLeafMemberPathPrefix(best.h),
      source: "sql_catalog",
      score: best.score
    };
  }

  // Fallback: miembros dimensión en manifiesto (catálogo local sin fila en olap_hierarchies)
  const dims = cube.members.filter((m) => m.type === "dimension");
  let bestM: { mdx: string; score: number } | null = null;
  for (const m of dims) {
    const score = scoreManifestDimension(m.mdxUniqueName, m.friendlyName, terms);
    if (!bestM || score > bestM.score) bestM = { mdx: m.mdxUniqueName, score };
  }

  if (bestM && bestM.score > 0) {
    const hu = bestM.mdx;
    return {
      hierarchyUniqueName: hu,
      rowsAxisMdxSet: `{ ${hu}.Members }`,
      leafMemberPathPrefix: hu,
      source: "manifest_fallback",
      score: bestM.score
    };
  }

  return null;
}
