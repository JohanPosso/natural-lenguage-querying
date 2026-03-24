/**
 * exportCatalogJson.ts
 *
 * Genera un archivo JSON completo y organizado con todo el catálogo OLAP:
 *   - Cubos (nombre técnico, catálogo, nombre XMLA)
 *   - Medidas de cada cubo
 *   - Dimensiones de cada cubo
 *   - Jerarquías de cada cubo (con sus miembros reales obtenidos de SSAS)
 *
 * Uso:
 *   ts-node src/scripts/exportCatalogJson.ts
 *   ts-node src/scripts/exportCatalogJson.ts --output=./mi-catalogo.json
 *   ts-node src/scripts/exportCatalogJson.ts --skip-members   (más rápido, sin valores)
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

import { getSqlPool } from "../services/sqlServerClient";
import { xmlaSyncService } from "../services/xmlaSyncService";

// -- CLI args ------------------------------------------------------------------
const args = process.argv.slice(2);
const outputArg = args.find((a) => a.startsWith("--output="));
const skipMembers = args.includes("--skip-members");
const OUTPUT_FILE = outputArg
  ? outputArg.replace("--output=", "")
  : path.resolve(process.cwd(), "catalog-export.json");

// -- Types ---------------------------------------------------------------------

type MemberValue = {
  caption: string;
  unique_name: string;
  level: string;
};

type HierarchyExport = {
  dimension_unique_name: string;
  hierarchy_unique_name: string;
  caption: string;
  members: MemberValue[] | "skipped";
  member_count: number | "skipped";
};

type DimensionExport = {
  technical_name: string;
  mdx_unique_name: string;
  friendly_name: string;
};

type MeasureExport = {
  technical_name: string;
  mdx_unique_name: string;
  friendly_name: string;
};

type CubeExport = {
  cube_name: string;
  catalog: string;
  xmla_cube_name: string;
  synced_at: string;
  measures: MeasureExport[];
  dimensions: DimensionExport[];
  hierarchies: HierarchyExport[];
};

type CatalogExport = {
  generated_at: string;
  ssas_endpoint: string;
  total_cubes: number;
  skip_members: boolean;
  cubes: CubeExport[];
};

// -- Helpers -------------------------------------------------------------------

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function logProgress(msg: string) {
  process.stdout.clearLine?.(0);
  process.stdout.cursorTo?.(0);
  process.stdout.write(msg);
}

async function fetchMembersForHierarchy(
  catalog: string,
  cubeName: string,
  hierarchyUniqueName: string
): Promise<MemberValue[]> {
  try {
    const rows = await xmlaSyncService.discoverRows(
      "MDSCHEMA_MEMBERS",
      {
        CATALOG_NAME: catalog,
        CUBE_NAME: cubeName,
        HIERARCHY_UNIQUE_NAME: hierarchyUniqueName,
        TREE_OP: "8" // MDTREEOP_CHILDREN of root = leaf members
      },
      catalog
    );

    return rows
      .filter((r) => r.MEMBER_CAPTION && r.MEMBER_CAPTION !== "(Blank)" && r.MEMBER_CAPTION !== "")
      .map((r) => ({
        caption: r.MEMBER_CAPTION ?? "",
        unique_name: r.MEMBER_UNIQUE_NAME ?? "",
        level: r.LEVEL_UNIQUE_NAME ?? ""
      }))
      .sort((a, b) => a.caption.localeCompare(b.caption, "es"));
  } catch {
    return [];
  }
}

// -- Main ----------------------------------------------------------------------

async function main() {
  log("╔==========================================================╗");
  log("║       EXPORTACIÓN DE CATÁLOGO OLAP -> JSON               ║");
  log("╚==========================================================╝");
  log(`  Archivo de salida : ${OUTPUT_FILE}`);
  log(`  Incluir miembros  : ${skipMembers ? "NO (--skip-members activo)" : "SÍ"}`);
  log("");

  // -- 1. Conectar a SQL y obtener cubos --------------------------------------
  log("► Conectando a SQL Server...");
  const pool = await getSqlPool();
  log("  [OK] Conectado\n");

  // Cubos
  const cubesRes = await pool.request().query<{
    id: number;
    cube_name: string;
    catalog: string;
    xmla_cube_name: string;
    synced_at: Date;
  }>(
    "SELECT id, cube_name, catalog, xmla_cube_name, synced_at FROM dbo.olap_cubes ORDER BY catalog, cube_name"
  );
  const cubeRows = cubesRes.recordset;
  log(`► ${cubeRows.length} cubos encontrados en el catálogo SQL.`);

  if (!cubeRows.length) {
    log("\n[WARN] No hay cubos en el catálogo. Ejecuta primero: npm run sync-catalog");
    process.exit(1);
  }

  const cubeIds = cubeRows.map((c) => c.id);

  // -- 2. Obtener miembros (medidas + dimensiones) de todos los cubos ---------
  const idList = cubeIds.join(",");
  const membersRes = await pool.request().query<{
    cube_id: number;
    cube_member: string;
    mdx_unique_name: string;
    friendly_name: string;
    member_type: string;
  }>(
    `SELECT cube_id, cube_member, mdx_unique_name, friendly_name, member_type
     FROM dbo.olap_members
     WHERE cube_id IN (${idList})
     ORDER BY cube_id, member_type DESC, friendly_name`
  );

  // -- 3. Obtener jerarquías de todos los cubos -------------------------------
  const hierarchiesRes = await pool.request().query<{
    cube_id: number;
    dimension_unique_name: string;
    hierarchy_unique_name: string;
    hierarchy_caption: string;
  }>(
    `SELECT cube_id, dimension_unique_name, hierarchy_unique_name, hierarchy_caption
     FROM dbo.olap_hierarchies
     WHERE cube_id IN (${idList})
     ORDER BY cube_id, dimension_unique_name, hierarchy_unique_name`
  );

  // -- 4. Agrupar por cubo ----------------------------------------------------
  type MemberRow = { cube_id: number; cube_member: string; mdx_unique_name: string; friendly_name: string; member_type: string };
  type HierarchyRow = { cube_id: number; dimension_unique_name: string; hierarchy_unique_name: string; hierarchy_caption: string };

  const membersByCube = new Map<number, MemberRow[]>();
  for (const m of membersRes.recordset) {
    if (!membersByCube.has(m.cube_id)) membersByCube.set(m.cube_id, []);
    membersByCube.get(m.cube_id)!.push(m);
  }

  const hierarchiesByCube = new Map<number, HierarchyRow[]>();
  for (const h of hierarchiesRes.recordset) {
    if (!hierarchiesByCube.has(h.cube_id)) hierarchiesByCube.set(h.cube_id, []);
    hierarchiesByCube.get(h.cube_id)!.push(h);
  }

  // -- 5. Construir el JSON por cubo ------------------------------------------
  log("");
  const cubesExport: CubeExport[] = [];

  for (let ci = 0; ci < cubeRows.length; ci++) {
    const cube = cubeRows[ci];
    log(`\n[${ci + 1}/${cubeRows.length}] ${cube.catalog} -> "${cube.xmla_cube_name}"`);

    const cubeMembers: MemberRow[]    = membersByCube.get(cube.id) ?? [];
    const cubeHierarchies: HierarchyRow[] = hierarchiesByCube.get(cube.id) ?? [];

    const measures: MeasureExport[] = cubeMembers
      .filter((m) => m.member_type === "measure")
      .map((m) => ({
        technical_name: m.cube_member,
        mdx_unique_name: m.mdx_unique_name,
        friendly_name: m.friendly_name
      }));

    const dimensions: DimensionExport[] = cubeMembers
      .filter((m) => m.member_type === "dimension")
      .map((m) => ({
        technical_name: m.cube_member,
        mdx_unique_name: m.mdx_unique_name,
        friendly_name: m.friendly_name
      }));

    log(`   Medidas   : ${measures.length}`);
    log(`   Dimensiones: ${dimensions.length}`);
    log(`   Jerarquías : ${cubeHierarchies.length}`);

    // -- Jerarquías con sus miembros ----------------------------------------
    const hierarchiesExport: HierarchyExport[] = [];

    for (let hi = 0; hi < cubeHierarchies.length; hi++) {
      const h = cubeHierarchies[hi];
      logProgress(`   Jerarquía ${hi + 1}/${cubeHierarchies.length}: ${h.hierarchy_caption}...`);

      let members: MemberValue[] | "skipped" = "skipped";
      let memberCount: number | "skipped" = "skipped";

      if (!skipMembers) {
        const fetched = await fetchMembersForHierarchy(
          cube.catalog,
          cube.xmla_cube_name,
          h.hierarchy_unique_name
        );
        members = fetched;
        memberCount = fetched.length;
      }

      hierarchiesExport.push({
        dimension_unique_name: h.dimension_unique_name,
        hierarchy_unique_name: h.hierarchy_unique_name,
        caption: h.hierarchy_caption,
        members,
        member_count: memberCount
      });
    }

    logProgress("");
    log(`   [OK] Cubo procesado`);

    cubesExport.push({
      cube_name: cube.cube_name,
      catalog: cube.catalog,
      xmla_cube_name: cube.xmla_cube_name,
      synced_at: cube.synced_at?.toISOString() ?? "",
      measures,
      dimensions,
      hierarchies: hierarchiesExport
    });
  }

  // -- 6. Ensamblar y escribir el JSON ---------------------------------------
  const output: CatalogExport = {
    generated_at: new Date().toISOString(),
    ssas_endpoint: process.env.XMLA_ENDPOINT ?? "",
    total_cubes: cubesExport.length,
    skip_members: skipMembers,
    cubes: cubesExport
  };

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  const sizeMb = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);

  log("\n");
  log("╔==========================================================╗");
  log("║                   EXPORTACIÓN COMPLETA                  ║");
  log("╚==========================================================╝");
  log(`  Cubos exportados : ${cubesExport.length}`);
  log(`  Archivo generado : ${OUTPUT_FILE}`);
  log(`  Tamaño del archivo: ${sizeMb} MB`);
  log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[exportCatalogJson] ERROR:", (err as Error).message);
  process.exit(1);
});
