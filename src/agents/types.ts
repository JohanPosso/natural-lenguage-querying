/**
 * Tipos compartidos entre los agentes del pipeline multiagente.
 *
 * Flujo:
 *   QueryIntent  (Agent 1 -> Agent 2)
 *   CatalogMapping (Agent 2 -> pipeline MDX)
 *   FinalAnswer    (Agent 3 -> usuario)
 */

// -- Agent 1 output: intención de la pregunta ---------------------------------

export type EntityType = "location" | "product" | "brand" | "segment" | "fuel" | "temporal" | "other";

export type QueryEntity = {
  /** Tipo semántico de la entidad */
  type: EntityType;
  /** Valor tal como lo dijo el usuario */
  rawValue: string;
  /**
   * Pista de normalización evidente (ej: "madrid" -> "MADRID", "enero" -> "Enero").
   * El Agente 2 puede ignorarla si encuentra una mejor coincidencia en el catálogo.
   */
  normalizedHint?: string;
};

export type QueryIntent = {
  /** Razonamiento breve del agente */
  reasoning: string;
  /**
   * Métricas/medidas que el usuario quiere ver.
   * Ej: ["matriculaciones", "central stock", "ventas"].
   */
  primaryMetrics: string[];
  /**
   * Entidades filtrables extraídas: provincias, marcas, segmentos, etc.
   * Pueden ser múltiples para la misma dimensión (Madrid y Valencia).
   */
  entities: QueryEntity[];
  /** Filtros temporales explícitos */
  timeFilters: {
    year?: string;   // "2025"
    month?: string;  // "Enero" (capitalizado en español)
  };
  /**
   * Si el usuario mencionó explícitamente un cubo o una marca/producto que sugiere uno.
   * Ej: "en el cubo Nissan", "datos de Renault Trucks".
   */
  preferredCube?: string;
  /** True si es una pregunta de seguimiento ("y para Barcelona?", "también en 2024") */
  isFollowUp: boolean;
  /** True si el usuario pregunta por los cubos/datos disponibles */
  isMetaQuestion: boolean;
  /** True si la pregunta está completamente fuera del dominio analítico */
  is_out_of_domain?: boolean;
  /**
   * Dominio de negocio inferido. Guía el pre-filtrado de cubos.
   * Ej: "automotive_sales", "vehicle_registration", "used_vehicles", "agriculture", "fleet"
   */
  domain: string;
};

// -- Agent 2 output: mapeo al catálogo OLAP -----------------------------------

export type MappedMeasure = {
  technical_name: string;   // "Cubo_Nissan_Cubo_Nissan.matriculaciones"
  friendly_name: string;    // "Matriculaciones"
  mdx_unique_name: string;  // "[Measures].[Matriculaciones]"
};

export type MappedFilter = {
  type: "year" | "month" | "dimension";
  hierarchy_mdx: string;   // "[Fecha].[Año]", "[-MT Territorios].[Provincia]"
  friendly_name: string;   // "Año", "Provincia"
  values: string[];        // ["2025"], ["MADRID", "VALENCIA"], ["Enero"]
};

export type CatalogMapping = {
  /** Razonamiento breve del agente */
  reasoning: string;
  /** Nombre exacto del cubo del catálogo (cubeName interno) */
  cube_name: string;
  measures: MappedMeasure[];
  filters: MappedFilter[];
};

// -- Turn de conversación pasado al pipeline -----------------------------------

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  cube?: string | null;
  measure?: string | null;
};
