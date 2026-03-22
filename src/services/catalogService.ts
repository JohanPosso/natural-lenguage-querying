/**
 * CatalogService — SQL Server como fuente única de verdad del catálogo OLAP.
 *
 * Reemplaza el archivo estático .xmla-manifest.json y el caché in-memory por tres
 * tablas SQL que se sincronizan contra SSAS bajo demanda:
 *
 *   dbo.olap_cubes       — uno por cubo descubierto en SSAS
 *   dbo.olap_members     — medidas y dimensiones de cada cubo
 *   dbo.olap_hierarchies — jerarquías completas (ej. [Fecha].[Año]) de cada cubo
 *
 * Ventajas vs. el JSON estático:
 *   - Filtrado por allowedCubes directo en SQL (el LLM nunca ve cubos prohibidos)
 *   - No hay archivo de 13K líneas que recargar en cada petición
 *   - Fácil de inspeccionar con cualquier herramienta SQL
 *   - Sincronización incremental: solo actualiza cubos que cambian
 */

import type { ConnectionPool } from "mssql";
import { env } from "../config/env";
import { getSqlPool } from "./sqlServerClient";

// ── Tipos públicos ────────────────────────────────────────────────────────────

/** Miembro de un cubo (medida o dimensión) compatible con el formato que usa askController */
export type XmlaManifestMember = {
  cubeMember: string;
  mdxUniqueName: string;
  friendlyName: string;
  type: "measure" | "dimension";
};

/** Cubo con sus miembros — compatible con el formato que usa askController */
export type XmlaManifestCube = {
  cubeName: string;
  catalog: string;
  xmlaCubeName: string;
  members: XmlaManifestMember[];
};

/** Manifiesto completo del catálogo — compatible con el formato actual de askController */
export type XmlaManifest = {
  generatedAt: string;
  endpoint: string;
  cubes: XmlaManifestCube[];
};

/** Jerarquía de una dimensión en SSAS (ej. [Fecha].[Año]) */
export type HierarchyInfo = {
  dimensionUniqueName: string;
  hierarchyUniqueName: string;
  hierarchyCaption: string;
};

// ── Helpers internos ──────────────────────────────────────────────────────────

function sanitizeCubeName(input: string): string {
  const normalized = input.replace(/[^\w]/g, "_").replace(/_+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "Cube";
}

function sanitizeIdentifier(input: string): string {
  const value = input
    .replace(/^\[|\]$/g, "")
    .replace(/\]\.\[/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "field";
  const camel = value
    .split(" ")
    .map((part, i) =>
      i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join("");
  return camel.match(/^[A-Za-z_]/) ? camel : `f_${camel}`;
}

function toUniqueKey(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

// ── Servicio ──────────────────────────────────────────────────────────────────

class CatalogService {
  private initialized = false;

  private async getPool(): Promise<ConnectionPool> {
    const pool = await getSqlPool();
    if (!this.initialized) {
      await this.ensureTables(pool);
      this.initialized = true;
    }
    return pool;
  }

  /** Crea las tablas si no existen. Idempotente. */
  private async ensureTables(pool: ConnectionPool): Promise<void> {
    await pool.request().query(`
      IF OBJECT_ID('dbo.olap_cubes', 'U') IS NULL
      CREATE TABLE dbo.olap_cubes (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        cube_name     NVARCHAR(255) NOT NULL,
        catalog       NVARCHAR(255) NOT NULL,
        xmla_cube_name NVARCHAR(255) NOT NULL,
        synced_at     DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_olap_cubes_name UNIQUE (cube_name)
      );
    `);

    await pool.request().query(`
      IF OBJECT_ID('dbo.olap_members', 'U') IS NULL
      CREATE TABLE dbo.olap_members (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        cube_id        INT NOT NULL,
        cube_member    NVARCHAR(500) NOT NULL,
        mdx_unique_name NVARCHAR(500) NOT NULL,
        friendly_name  NVARCHAR(500) NOT NULL,
        member_type    NVARCHAR(20) NOT NULL,
        synced_at      DATETIME DEFAULT GETDATE(),
        CONSTRAINT FK_olap_members_cube FOREIGN KEY (cube_id)
          REFERENCES dbo.olap_cubes(id) ON DELETE CASCADE
      );
    `);

    await pool.request().query(`
      IF OBJECT_ID('dbo.olap_hierarchies', 'U') IS NULL
      CREATE TABLE dbo.olap_hierarchies (
        id                    INT IDENTITY(1,1) PRIMARY KEY,
        cube_id               INT NOT NULL,
        dimension_unique_name NVARCHAR(500) NOT NULL,
        hierarchy_unique_name NVARCHAR(500) NOT NULL,
        hierarchy_caption     NVARCHAR(500) NOT NULL,
        synced_at             DATETIME DEFAULT GETDATE(),
        CONSTRAINT FK_olap_hierarchies_cube FOREIGN KEY (cube_id)
          REFERENCES dbo.olap_cubes(id) ON DELETE CASCADE
      );
    `);

    const countResult = await pool
      .request()
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.olap_cubes");
    const count = countResult.recordset[0].n;
    console.log(`[catalogService] Tablas OK — ${count} cubo(s) en catálogo`);
  }

  /**
   * Devuelve el manifiesto de catálogo filtrado por allowedCubes.
   * allowedCubes = null → todos los cubos (BYPASS_AUTH).
   * Compara contra cube_name, catalog y xmla_cube_name para máxima compatibilidad
   * con los nombres que devuelve el API Launcher.
   */
  async getManifest(allowedCubes?: string[] | null): Promise<XmlaManifest> {
    const pool = await this.getPool();

    // ── Obtener cubos ──────────────────────────────────────────────────────
    const cubeReq = pool.request();
    let cubeWhere = "";

    if (allowedCubes && allowedCubes.length > 0) {
      const params = allowedCubes.flatMap((name, i) => {
        cubeReq.input(`ac${i}`, name);
        return [`@ac${i}`];
      });
      const list = params.join(", ");
      cubeWhere = `WHERE cube_name IN (${list}) OR catalog IN (${list}) OR xmla_cube_name IN (${list})`;
    }

    const cubesRes = await cubeReq.query<{
      id: number;
      cube_name: string;
      catalog: string;
      xmla_cube_name: string;
      synced_at: Date;
    }>(`SELECT id, cube_name, catalog, xmla_cube_name, synced_at
        FROM dbo.olap_cubes ${cubeWhere}
        ORDER BY catalog, cube_name`);

    const cubes = cubesRes.recordset;
    if (!cubes.length) {
      return { generatedAt: new Date().toISOString(), endpoint: "", cubes: [] };
    }

    const cubeIds = cubes.map((c) => c.id);

    // ── Obtener miembros de esos cubos ────────────────────────────────────
    const memReq = pool.request();
    const idParams = cubeIds.map((id, i) => {
      memReq.input(`cid${i}`, id);
      return `@cid${i}`;
    });
    const membersRes = await memReq.query<{
      cube_id: number;
      cube_member: string;
      mdx_unique_name: string;
      friendly_name: string;
      member_type: string;
    }>(`SELECT cube_id, cube_member, mdx_unique_name, friendly_name, member_type
        FROM dbo.olap_members
        WHERE cube_id IN (${idParams.join(",")})`);

    const membersByCubeId = new Map<number, XmlaManifestMember[]>();
    for (const row of membersRes.recordset) {
      if (!membersByCubeId.has(row.cube_id)) membersByCubeId.set(row.cube_id, []);
      membersByCubeId.get(row.cube_id)!.push({
        cubeMember: row.cube_member,
        mdxUniqueName: row.mdx_unique_name,
        friendlyName: row.friendly_name,
        type: row.member_type as "measure" | "dimension"
      });
    }

    const latestSync = cubes[0].synced_at;
    return {
      generatedAt: latestSync?.toISOString() ?? new Date().toISOString(),
      endpoint: env.xmlaEndpoint,
      cubes: cubes.map((c) => ({
        cubeName: c.cube_name,
        catalog: c.catalog,
        xmlaCubeName: c.xmla_cube_name,
        members: membersByCubeId.get(c.id) ?? []
      }))
    };
  }

  /**
   * Devuelve las jerarquías de un cubo desde SQL.
   * No hace llamadas a SSAS — los datos ya están sincronizados.
   */
  async getHierarchiesForCube(catalog: string, cubeName: string): Promise<HierarchyInfo[]> {
    const pool = await this.getPool();

    const cubeRes = await pool
      .request()
      .input("catalog", catalog)
      .input("cubeName", cubeName)
      .query<{ id: number }>(
        `SELECT TOP 1 id FROM dbo.olap_cubes
         WHERE catalog = @catalog AND xmla_cube_name = @cubeName`
      );

    if (!cubeRes.recordset.length) return [];

    const cubeId = cubeRes.recordset[0].id;
    const hierRes = await pool
      .request()
      .input("cubeId", cubeId)
      .query<{
        dimension_unique_name: string;
        hierarchy_unique_name: string;
        hierarchy_caption: string;
      }>(
        `SELECT dimension_unique_name, hierarchy_unique_name, hierarchy_caption
         FROM dbo.olap_hierarchies
         WHERE cube_id = @cubeId
         ORDER BY dimension_unique_name, hierarchy_unique_name`
      );

    return hierRes.recordset.map((row) => ({
      dimensionUniqueName: row.dimension_unique_name,
      hierarchyUniqueName: row.hierarchy_unique_name,
      hierarchyCaption: row.hierarchy_caption
    }));
  }

  /**
   * Sincroniza el catálogo desde SSAS hacia SQL Server.
   * Recibe la función de discover de xmlaSyncService para no duplicar lógica XMLA.
   * Para cada cubo: upsert en olap_cubes, reemplaza olap_members y olap_hierarchies.
   */
  async syncFromSsas(
    discoverFn: (
      requestType: string,
      restrictions?: Record<string, string>,
      catalog?: string
    ) => Promise<Array<Record<string, string>>>
  ): Promise<{ cubes: number; members: number; hierarchies: number }> {
    const pool = await this.getPool();

    // Descubrir catálogos
    const catalogRows = await discoverFn("DBSCHEMA_CATALOGS");
    let catalogs = catalogRows.map((r) => r.CATALOG_NAME).filter(Boolean);
    if (env.xmlaCatalog) catalogs = catalogs.filter((c) => c === env.xmlaCatalog);
    catalogs = [...new Set(catalogs)];

    let totalCubes = 0;
    let totalMembers = 0;
    let totalHierarchies = 0;

    for (const catalog of catalogs) {
      const cubeRows = await discoverFn("MDSCHEMA_CUBES", undefined, catalog);
      const cubeNames = cubeRows
        .map((r) => r.CUBE_NAME)
        .filter((n): n is string => Boolean(n) && n.toUpperCase() !== "$SYSTEM");

      for (const xmlaCubeName of cubeNames) {
        const cubeName = sanitizeCubeName(`${catalog}_${xmlaCubeName}`);

        // Upsert cubo
        const cubeUpsert = await pool
          .request()
          .input("cubeName", cubeName)
          .input("catalog", catalog)
          .input("xmlaCubeName", xmlaCubeName)
          .query<{ id: number }>(
            `MERGE dbo.olap_cubes AS target
             USING (SELECT @cubeName AS cube_name, @catalog AS catalog, @xmlaCubeName AS xmla_cube_name) AS src
             ON target.cube_name = src.cube_name
             WHEN MATCHED THEN
               UPDATE SET catalog = src.catalog, xmla_cube_name = src.xmla_cube_name, synced_at = GETDATE()
             WHEN NOT MATCHED THEN
               INSERT (cube_name, catalog, xmla_cube_name)
               VALUES (src.cube_name, src.catalog, src.xmla_cube_name)
             OUTPUT inserted.id;`
          );

        const cubeId = cubeUpsert.recordset[0].id;

        // Limpiar miembros y jerarquías anteriores
        await pool.request().input("id", cubeId).query("DELETE FROM dbo.olap_members WHERE cube_id = @id");
        await pool.request().input("id", cubeId).query("DELETE FROM dbo.olap_hierarchies WHERE cube_id = @id");

        // ── Medidas ──────────────────────────────────────────────────────
        const measureRows = await discoverFn("MDSCHEMA_MEASURES", { CUBE_NAME: xmlaCubeName }, catalog);
        const usedMeasureKeys = new Set<string>();

        for (const row of measureRows) {
          const mdxUniqueName = row.MEASURE_UNIQUE_NAME || row.MEASURE_NAME;
          if (!mdxUniqueName) continue;
          const friendlyName = row.MEASURE_CAPTION || row.MEASURE_NAME || mdxUniqueName;
          const key = toUniqueKey(sanitizeIdentifier(mdxUniqueName), usedMeasureKeys);
          await pool
            .request()
            .input("cubeId", cubeId)
            .input("cubeMember", `${cubeName}.${key}`)
            .input("mdxUniqueName", mdxUniqueName)
            .input("friendlyName", friendlyName)
            .input("memberType", "measure")
            .query(
              `INSERT INTO dbo.olap_members (cube_id, cube_member, mdx_unique_name, friendly_name, member_type)
               VALUES (@cubeId, @cubeMember, @mdxUniqueName, @friendlyName, @memberType)`
            );
          totalMembers++;
        }

        // ── Dimensiones ──────────────────────────────────────────────────
        const dimRows = await discoverFn("MDSCHEMA_DIMENSIONS", { CUBE_NAME: xmlaCubeName }, catalog);
        const usedDimKeys = new Set<string>();

        for (const row of dimRows) {
          const mdxUniqueName = row.DIMENSION_UNIQUE_NAME || row.DIMENSION_NAME;
          if (!mdxUniqueName || mdxUniqueName.toUpperCase() === "[MEASURES]") continue;
          const friendlyName = row.DIMENSION_CAPTION || row.DIMENSION_NAME || mdxUniqueName;
          const key = toUniqueKey(sanitizeIdentifier(mdxUniqueName), usedDimKeys);
          await pool
            .request()
            .input("cubeId", cubeId)
            .input("cubeMember", `${cubeName}.${key}`)
            .input("mdxUniqueName", mdxUniqueName)
            .input("friendlyName", friendlyName)
            .input("memberType", "dimension")
            .query(
              `INSERT INTO dbo.olap_members (cube_id, cube_member, mdx_unique_name, friendly_name, member_type)
               VALUES (@cubeId, @cubeMember, @mdxUniqueName, @friendlyName, @memberType)`
            );
          totalMembers++;
        }

        // ── Jerarquías ────────────────────────────────────────────────────
        const hierRows = await discoverFn("MDSCHEMA_HIERARCHIES", { CUBE_NAME: xmlaCubeName }, catalog);
        for (const row of hierRows) {
          const hierarchyUniqueName = row.HIERARCHY_UNIQUE_NAME;
          if (!hierarchyUniqueName || hierarchyUniqueName.startsWith("[Measures]")) continue;
          // DIMENSION_UNIQUE_NAME de SSAS es el nombre de la dimensión padre (ej: "[-MT Producto]").
          // Si SSAS no lo devuelve, se extrae del prefijo del hierarchy unique name:
          // "[-MT Producto].[Marca]" → "[-MT Producto]"
          let dimUnique = row.DIMENSION_UNIQUE_NAME ?? "";
          if (!dimUnique && hierarchyUniqueName.includes("].")) {
            dimUnique = hierarchyUniqueName.substring(0, hierarchyUniqueName.lastIndexOf("].") + 1);
          } else if (!dimUnique) {
            dimUnique = hierarchyUniqueName;
          }
          await pool
            .request()
            .input("cubeId", cubeId)
            .input("dimUnique", dimUnique)
            .input("hierUnique", hierarchyUniqueName)
            .input("hierCaption", row.HIERARCHY_CAPTION || row.HIERARCHY_NAME || "")
            .query(
              `INSERT INTO dbo.olap_hierarchies (cube_id, dimension_unique_name, hierarchy_unique_name, hierarchy_caption)
               VALUES (@cubeId, @dimUnique, @hierUnique, @hierCaption)`
            );
          totalHierarchies++;
        }

        totalCubes++;
        console.log(`[catalogService] ✓ ${catalog}/${xmlaCubeName} — ${measureRows.length} medidas, ${hierRows.length} jerarquías`);
      }
    }

    console.log(`[catalogService] Sincronización completada: ${totalCubes} cubos, ${totalMembers} miembros, ${totalHierarchies} jerarquías`);
    return { cubes: totalCubes, members: totalMembers, hierarchies: totalHierarchies };
  }

  /** Devuelve cuántos cubos hay actualmente en el catálogo. */
  async getCubeCount(): Promise<number> {
    const pool = await this.getPool();
    const res = await pool
      .request()
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.olap_cubes");
    return res.recordset[0].n;
  }
}

export const catalogService = new CatalogService();
