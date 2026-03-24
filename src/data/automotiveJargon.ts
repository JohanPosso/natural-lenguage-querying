/**
 * GLOSARIO DE JERGAS Y TÉRMINOS TÉCNICOS — SECTOR AUTOMOCIÓN ESPAÑOL
 *
 * Este archivo centraliza el vocabulario del sector automoción que los usuarios
 * pueden usar en sus consultas. Sirve para dos propósitos:
 *
 *  1. PRE-NORMALIZACIÓN: sustituir términos antes de enviarlos al intérprete LLM
 *     (solo para coincidencias exactas/simples, con límite de palabra).
 *
 *  2. CONTEXTO LLM: el glosario completo se inyecta en el prompt del intérprete
 *     para que razone sobre variaciones no cubiertas por la normalización.
 *
 * Para añadir términos nuevos: agrega entradas al array JARGON_ENTRIES.
 * Cada campo es explícito — no hace falta tocar ningún otro archivo.
 */

export type JargonType =
  | "measure"    // métrica / KPI
  | "segment"    // segmento de producto / categoría
  | "fuel"       // tipo de combustible / fuente de energía (eléctrico, diésel, gasolina...)
  | "geography"  // zona geográfica o región
  | "temporal"   // período de tiempo o comparativa temporal
  | "brand"      // marca de vehículo
  | "channel"    // canal de venta
  | "other";     // cualquier otra jerga del sector

export interface JargonEntry {
  /** Términos alternativos que el usuario puede usar */
  jargon: string[];
  /** Término canónico que el sistema y el catálogo entienden */
  canonical: string;
  type: JargonType;
  /** Descripción adicional del término para el contexto del LLM */
  description?: string;
  /**
   * Si true, la pre-normalización reemplazará este término en el prompt
   * antes de enviarlo al intérprete. Solo activar cuando la sustitución
   * sea inequívoca (nunca tiene otro significado).
   */
  preNormalize?: boolean;
}

// -----------------------------------------------------------------------------
// MEDIDAS / KPIs
// -----------------------------------------------------------------------------
const MEASURES: JargonEntry[] = [
  {
    jargon: [
      "unidades", "autos", "coches vendidos", "carros", "matris",
      "immatricolaciones", "registros", "altas", "salidas",
      "ventas de coches", "unidades vendidas", "vehículos matriculados"
    ],
    canonical: "matriculaciones",
    type: "measure",
    description: "Número de vehículos nuevos registrados oficialmente ante la DGT",
    preNormalize: true
  },
  {
    jargon: [
      "matriculaciones del mercado", "mercado dgt", "mercado total",
      "matriculaciones mercado", "total mercado dgt", "mercado de matriculaciones",
      "matriculaciones totales mercado", "volumen mercado"
    ],
    canonical: "Matriculaciones",
    type: "measure",
    description: "En cubos con datos DGT (ej: Cubo Nissan), 'Matriculaciones' sin sufijo = total todas las marcas (mercado DGT completo). NO confundir con Matriculaciones Nissan (solo la marca).",
    preNormalize: false
  },
  {
    jargon: [
      "cuota", "market share", "share", "participación de mercado",
      "porcentaje de mercado", "share de mercado", "cuota del mercado",
      "participación", "penetración"
    ],
    canonical: "cuota de mercado",
    type: "measure",
    description: "Porcentaje de matriculaciones de una marca sobre el total del mercado",
    preNormalize: true
  },
  {
    jargon: ["ventas declaradas", "ventas al mayor", "ventas oficiales"],
    canonical: "ventas declaradas",
    type: "measure",
    description: "Ventas comunicadas oficialmente por el fabricante",
    preNormalize: false
  },
  {
    jargon: [
      "ytd", "acumulado año", "acumulado anual", "año hasta la fecha",
      "total año hasta hoy", "desde enero"
    ],
    canonical: "acumulado YTD",
    type: "temporal",
    description: "Acumulado Year-To-Date: suma desde el 1 de enero hasta el período actual"
  },
  {
    jargon: [
      "lytd", "año anterior hasta la fecha", "mismo periodo año pasado",
      "periodo comparable año anterior", "igual periodo año anterior",
      "acumulado año pasado"
    ],
    canonical: "LYTD",
    type: "temporal",
    description: "Last Year To Date: acumulado del mismo período del año anterior"
  },
  {
    jargon: [
      "mtd", "acumulado mes", "mes hasta la fecha", "desde el 1 del mes"
    ],
    canonical: "acumulado MTD",
    type: "temporal",
    description: "Month-To-Date: acumulado del mes actual hasta hoy"
  },
  {
    jargon: [
      "stock", "inventario", "unidades en stock", "coches en stock",
      "disponibles", "unidades disponibles", "almacén"
    ],
    canonical: "stock",
    type: "measure",
    description: "Número de vehículos disponibles en almacén o concesionario"
  },
  {
    jargon: [
      "días de stock", "cobertura", "días de venta", "días de rotación",
      "rotación de stock", "días cobertura"
    ],
    canonical: "días de stock",
    type: "measure",
    description: "Número de días que tardaría en venderse el stock actual al ritmo actual"
  },
  {
    jargon: [
      "presupuesto", "budget", "objetivo", "target", "plan de ventas",
      "plan comercial", "forecast"
    ],
    canonical: "presupuesto",
    type: "measure",
    description: "Objetivo de ventas o matriculaciones planificado para el período"
  },
  {
    jargon: [
      "cumplimiento", "% objetivo", "avance objetivo", "porcentaje objetivo",
      "grado de cumplimiento", "achievement"
    ],
    canonical: "cumplimiento de objetivo",
    type: "measure",
    description: "Porcentaje de ejecución sobre el objetivo o presupuesto"
  },
  {
    jargon: ["variación", "variación anual", "diferencia vs año anterior", "vs py", "vs año anterior"],
    canonical: "variación unidades",
    type: "measure",
    description: "Diferencia en unidades respecto al mismo período del año anterior"
  },
  {
    jargon: ["crecimiento", "incremento", "evolución", "tendencia", "% variación", "porcentaje variación"],
    canonical: "variación porcentual",
    type: "measure",
    description: "Variación porcentual respecto al período de referencia"
  },
  {
    jargon: [
      "total mercado", "mercado total", "mercado España", "el mercado",
      "volumen de mercado", "total España", "total del sector"
    ],
    canonical: "Total Mercado",
    type: "measure",
    description: "Suma de todas las matriculaciones del mercado (todas las marcas)"
  }
];

// -----------------------------------------------------------------------------
// SEGMENTOS DE PRODUCTO
// -----------------------------------------------------------------------------
const SEGMENTS: JargonEntry[] = [
  {
    jargon: [
      "suv", "suvs", "crossover", "todocamino", "crossovers",
      "todo camino", "vehículo utilitario deportivo"
    ],
    canonical: "SUV",
    type: "segment",
    description: "Sport Utility Vehicle — vehículos con carrocería alta tipo crossover",
    preNormalize: true
  },
  {
    jargon: [
      "4x4", "todo terreno", "todoterreno", "todoterrenos", "offroad",
      "off road", "4wd", "awd", "doble tracción"
    ],
    canonical: "todoterreno",
    type: "segment",
    description: "Vehículos de tracción total diseñados para uso fuera de asfalto",
    preNormalize: true
  },
  {
    jargon: [
      "berlinas", "sedán", "sedanes", "turismo", "turismos clásicos",
      "coche de tres cajas", "tres volúmenes"
    ],
    canonical: "berlina",
    type: "segment",
    description: "Segmento de turismo clásico con maletero separado"
  },
  {
    jargon: [
      "utilitarios", "utilitario", "urbanos", "compactos urbanos",
      "coches pequeños", "coche de ciudad"
    ],
    canonical: "utilitario",
    type: "segment",
    description: "Segmento A/B — vehículos pequeños para uso urbano"
  },
  {
    jargon: [
      "compactos", "compacto", "segmento c", "clase c", "golf class"
    ],
    canonical: "compacto",
    type: "segment",
    description: "Segmento C — vehículos compactos, el más voluminoso del mercado"
  },
  {
    jargon: [
      "monovolumen", "monovolúmenes", "mpv", "furgoneta familiar",
      "van familiar", "mvp"
    ],
    canonical: "monovolumen",
    type: "segment",
    description: "Multi Purpose Vehicle — vehículos de gran habitabilidad interior"
  },
  {
    jargon: [
      "motos", "motocicletas", "dos ruedas", "moto", "scooter", "scooters",
      "ciclomotores", "motociclismo"
    ],
    canonical: "motocicletas",
    type: "segment",
    description: "Segmento de vehículos de dos ruedas (L1e–L7e)"
  },
  {
    jargon: [
      "furgonetas", "vehículos comerciales ligeros", "vcl", "van",
      "furgón", "vehículo de carga"
    ],
    canonical: "vehículos comerciales ligeros",
    type: "segment",
    description: "Vehículos de carga ligera (VCL) — furgonetas y derivados"
  },
  {
    jargon: [
      "eléctricos", "bev", "vehículo eléctrico", "coche eléctrico",
      "coches eléctricos", "100% eléctrico", "pure electric", "ve",
      "electrico", "electricos", "vehículos eléctricos"
    ],
    canonical: "Electrico",
    type: "fuel",
    description: "Tipo de combustible/energía eléctrica. DIMENSION SSAS: 'Fuente de energía' o 'Combustible'. NO es un segmento de vehículo."
  },
  {
    jargon: [
      "híbridos", "híbrido enchufable", "phev", "plug in", "enchufable",
      "híbrido convencional", "hev", "mhev", "mild hybrid", "hibrido", "hibridos"
    ],
    canonical: "Híbrido",
    type: "fuel",
    description: "Tipo de propulsión híbrida. DIMENSION SSAS: 'Fuente de energía' o 'Combustible'. NO es un segmento de vehículo."
  },
  {
    jargon: ["diésel", "diesel", "gasoil", "aceite", "gasóleo"],
    canonical: "Diésel",
    type: "fuel",
    description: "Tipo de combustible diésel. DIMENSION SSAS: 'Fuente de energía' o 'Combustible'. NO es un segmento de vehículo."
  },
  {
    jargon: ["gasolina", "naftero", "nafta", "benzina", "nafta sin plomo"],
    canonical: "Gasolina",
    type: "fuel",
    description: "Tipo de combustible gasolina. DIMENSION SSAS: 'Fuente de energía' o 'Combustible'. NO es un segmento de vehículo."
  },
  {
    jargon: [
      "premium", "lujo", "gama alta", "alta gama", "segmento e", "segmento f",
      "executive", "gran turismo"
    ],
    canonical: "premium",
    type: "segment",
    description: "Segmento de vehículos de alta gama y precio elevado"
  }
];

// -----------------------------------------------------------------------------
// GEOGRAFÍA
// -----------------------------------------------------------------------------
const GEOGRAPHY: JargonEntry[] = [
  {
    jargon: ["la capital", "capital", "km 0", "madrid capital", "villa y corte"],
    canonical: "MADRID",
    type: "geography",
    description: "Provincia de Madrid",
    preNormalize: false
  },
  {
    jargon: ["la ciudad condal", "barcelona ciudad", "cataluña capital"],
    canonical: "BARCELONA",
    type: "geography",
    description: "Provincia de Barcelona"
  },
  {
    jargon: [
      "levante", "zona levante", "arco mediterráneo", "mediterráneo",
      "zona mediterránea"
    ],
    canonical: "Valencia, Alicante, Murcia",
    type: "geography",
    description: "Zona geográfica mediterránea — incluye Valencia, Alicante y Murcia"
  },
  {
    jargon: [
      "zona norte", "norte de España", "cornisa cantábrica", "cantábrico"
    ],
    canonical: "Euskadi, Cantabria, Asturias, Galicia",
    type: "geography",
    description: "Zona norte de España — CCAA de la cornisa cantábrica"
  },
  {
    jargon: [
      "andalucía", "el sur", "zona sur", "sur de España"
    ],
    canonical: "Andalucía",
    type: "geography",
    description: "Comunidad Autónoma de Andalucía (Sevilla, Málaga, etc.)"
  },
  {
    jargon: ["país vasco", "euskadi", "pv", "euzkadi", "vascos"],
    canonical: "EUSKADI",
    type: "geography",
    description: "País Vasco (Álava, Bizkaia, Gipuzkoa)"
  },
  {
    jargon: ["canarias", "islas canarias", "las islas", "archipielago canario"],
    canonical: "Canarias",
    type: "geography",
    description: "Comunidad Autónoma de Canarias"
  },
  {
    jargon: ["baleares", "islas baleares", "mallorca", "ibiza", "menorca"],
    canonical: "Baleares",
    type: "geography",
    description: "Comunidad Autónoma de Illes Balears"
  }
];

// -----------------------------------------------------------------------------
// CANALES DE VENTA
// -----------------------------------------------------------------------------
const CHANNELS: JargonEntry[] = [
  {
    jargon: [
      "particulares", "clientes particulares", "mercado retail",
      "ventas a particulares", "consumidores finales", "b2c"
    ],
    canonical: "particulares",
    type: "channel",
    description: "Canal de venta directa a consumidor particular (retail)"
  },
  {
    jargon: [
      "flotas", "empresas", "fleet", "renting", "alquiler",
      "rent a car", "vehículo de empresa", "flota corporativa", "b2b"
    ],
    canonical: "flotas",
    type: "channel",
    description: "Canal de ventas a empresas, renting y flotas corporativas"
  },
  {
    jargon: [
      "autoescuelas", "escuelas de conducción", "vehículos de enseñanza"
    ],
    canonical: "autoescuelas",
    type: "channel",
    description: "Canal de ventas a autoescuelas y centros de formación vial"
  },
  {
    jargon: [
      "concesionarios", "dealer", "dealers", "red de ventas",
      "puntos de venta", "distribuidores"
    ],
    canonical: "concesionarios",
    type: "channel",
    description: "Red de distribución y puntos de venta autorizados"
  }
];

// -----------------------------------------------------------------------------
// TÉRMINOS TEMPORALES Y COMPARATIVAS
// -----------------------------------------------------------------------------
const TEMPORAL: JargonEntry[] = [
  {
    jargon: [
      "el año pasado", "el año anterior", "el año previo",
      "año pasado", "el ejercicio anterior", "py"
    ],
    canonical: "año anterior",
    type: "temporal",
    description: "Referencia al año natural inmediatamente anterior al actual"
  },
  {
    jargon: [
      "este año", "año en curso", "año actual", "el ejercicio",
      "el año", "año corriente"
    ],
    canonical: "año actual",
    type: "temporal",
    description: "Referencia al año natural en curso"
  },
  {
    jargon: [
      "este mes", "mes en curso", "mes actual", "el mes",
      "mes corriente"
    ],
    canonical: "mes actual",
    type: "temporal",
    description: "Referencia al mes natural en curso"
  },
  {
    jargon: [
      "último trimestre", "q4", "q3", "q2", "q1",
      "trimestre anterior", "tercer trimestre", "cuarto trimestre"
    ],
    canonical: "trimestre",
    type: "temporal",
    description: "Período trimestral (Q1=Ene-Mar, Q2=Abr-Jun, Q3=Jul-Sep, Q4=Oct-Dic)"
  },
  {
    jargon: [
      "primer semestre", "segundo semestre", "semestre 1", "semestre 2",
      "s1", "s2", "primer medio año", "primer half"
    ],
    canonical: "semestre",
    type: "temporal",
    description: "Período semestral (S1=Ene-Jun, S2=Jul-Dic)"
  }
];

// -----------------------------------------------------------------------------
// MARCAS / FABRICANTES
// -----------------------------------------------------------------------------
const BRANDS: JargonEntry[] = [
  {
    jargon: ["la japonesa", "el japonés", "niss", "nisan"],
    canonical: "Nissan",
    type: "brand",
    description: "Marca japonesa Nissan"
  },
  {
    jargon: ["la oval", "ford motor", "ovalo azul"],
    canonical: "Ford",
    type: "brand",
    description: "Marca americana Ford"
  },
  {
    jargon: ["stellantis", "grupo psa", "fca"],
    canonical: "Stellantis",
    type: "brand",
    description: "Grupo automovilístico Stellantis (Peugeot, Citroën, Fiat, Opel, etc.)"
  },
  {
    jargon: ["vag", "grupo vw", "volkswagen group", "grupo volkswagen"],
    canonical: "Volkswagen Group",
    type: "brand",
    description: "Grupo Volkswagen (VW, Audi, Seat, Skoda, Porsche, etc.)"
  }
];

// -----------------------------------------------------------------------------
// EXPORT PRINCIPAL
// -----------------------------------------------------------------------------

/** Glosario completo del sector automoción */
export const JARGON_ENTRIES: JargonEntry[] = [
  ...MEASURES,
  ...SEGMENTS,
  ...GEOGRAPHY,
  ...CHANNELS,
  ...TEMPORAL,
  ...BRANDS
];

// -----------------------------------------------------------------------------
// PRE-NORMALIZACIÓN
// -----------------------------------------------------------------------------

export interface NormalizationResult {
  /** Texto con las jergas sustituidas por sus términos canónicos */
  normalized: string;
  /** Lista de sustituciones realizadas para auditoría/logging */
  substitutions: Array<{ from: string; to: string; type: JargonType }>;
}

/**
 * Sustituye jergas conocidas por sus términos canónicos en el texto.
 * Solo actúa sobre entradas con `preNormalize: true`.
 * Respeta límites de palabra para evitar sustituciones parciales.
 */
export function normalizeJargon(text: string): NormalizationResult {
  const substitutions: NormalizationResult["substitutions"] = [];
  let normalized = text;

  const candidates = JARGON_ENTRIES.filter((e) => e.preNormalize === true);

  for (const entry of candidates) {
    for (const term of entry.jargon) {
      // Evitar auto-reemplazos cuando la jerga es igual al canónico
      if (term.toLowerCase() === entry.canonical.toLowerCase()) continue;

      // Escapar caracteres especiales de regex
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\wáéíóúüñÁÉÍÓÚÜÑ])${escaped}(?![\\wáéíóúüñÁÉÍÓÚÜÑ])`, "gi");

      if (pattern.test(normalized)) {
        normalized = normalized.replace(pattern, entry.canonical);
        substitutions.push({ from: term, to: entry.canonical, type: entry.type });
      }
    }
  }

  return { normalized, substitutions };
}

// -----------------------------------------------------------------------------
// CONTEXTO LLM — glosario formateado para inyectar en prompts
// -----------------------------------------------------------------------------

/**
 * Genera un bloque de texto con el glosario completo para incluir
 * en el system prompt del intérprete.
 */
export function buildJargonContextBlock(): string {
  const lines: string[] = [
    "=== GLOSARIO DE JERGAS — SECTOR AUTOMOCIÓN ESPAÑOL ===",
    "Cuando el usuario use alguno de los términos de la columna 'JERGA', interpreta",
    "como si hubiera usado el término 'CANÓNICO' correspondiente.",
    ""
  ];

  const byType: Record<JargonType, JargonEntry[]> = {
    measure:   [],
    segment:   [],
    fuel:      [],
    geography: [],
    temporal:  [],
    brand:     [],
    channel:   [],
    other:     []
  };

  for (const entry of JARGON_ENTRIES) {
    byType[entry.type].push(entry);
  }

  const labels: Record<JargonType, string> = {
    measure:   "MEDIDAS / KPIs",
    segment:   "SEGMENTOS DE PRODUCTO",
    fuel:      "TIPOS DE COMBUSTIBLE / ENERGÍA (-> dimensión 'Fuente de energía', NO 'Segmento')",
    geography: "ZONAS GEOGRÁFICAS",
    temporal:  "PERÍODOS TEMPORALES",
    brand:     "MARCAS / FABRICANTES",
    channel:   "CANALES DE VENTA",
    other:     "OTROS TÉRMINOS"
  };

  for (const [type, entries] of Object.entries(byType) as [JargonType, JargonEntry[]][]) {
    if (entries.length === 0) continue;
    lines.push(`-- ${labels[type]} --`);
    for (const e of entries) {
      const jargonList = e.jargon.slice(0, 6).join(", "); // máx 6 para no saturar
      lines.push(`  - ${jargonList} -> "${e.canonical}"`);
      if (e.description) lines.push(`    (${e.description})`);
    }
    lines.push("");
  }

  lines.push("=== FIN GLOSARIO ===");
  return lines.join("\n");
}
