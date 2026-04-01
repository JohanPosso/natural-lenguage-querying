/**
 * Niveles de confianza para coincidencias filtro → miembro OLAP.
 * Se usa en resolveFilters y en el contexto del agente de respuesta.
 */

export type FilterMatchLevel = "high" | "medium" | "low";

/** Cache SQL / mismos pesos que mdxBridgeService.findBestMemberByCaption */
export function levelFromSqlOrXmlaScore(score: number, isExactCaption: boolean): FilterMatchLevel {
  if (isExactCaption || score >= 20) return "high";
  if (score >= 10) return "medium";
  return "low";
}

/** Coincidencias por prefijo / contains múltiple (término paraguas) */
export function levelForUmbrellaExpansion(): FilterMatchLevel {
  return "medium";
}

/** Único match contains sin saber score fino */
export function levelForSingleContains(): FilterMatchLevel {
  return "medium";
}

/** Filtro año construido con patrón predecible */
export function levelForYearFallback(): FilterMatchLevel {
  return "high";
}

export function shouldWarnUser(level: FilterMatchLevel): boolean {
  return level === "low" || level === "medium";
}
