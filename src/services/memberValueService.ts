import sql from "mssql";
import type { ConnectionPool } from "mssql";
import { getSqlPool } from "./sqlServerClient";

type DiscoverFn = (
  requestType: string,
  restrictions?: Record<string, string>,
  catalog?: string
) => Promise<Array<Record<string, string>>>;

export type ResolvedMember = {
  caption: string;
  uniqueName: string;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Jerarquías que se saltan en el sync de valores:
 *  - [Measures]: no es dimensión, no hay miembros filtrables
 *  - Jerarquías de fecha detallada (día, semana) que generan decenas de miles de filas sin utilidad
 */
const SKIP_HIERARCHY_PATTERNS = [
  /^\[Measures\]/i,
  /\.\[D[íi]a\]/i,
  /\.\[Semana\]/i,
  /\.\[Fecha\]$/i,
];

function shouldSkipHierarchy(h: string): boolean {
  return SKIP_HIERARCHY_PATTERNS.some((re) => re.test(h));
}

class MemberValueService {
  private initialized = false;

  private async ensureTable(pool: ConnectionPool): Promise<void> {
    if (this.initialized) return;

    await pool.request().query(`
      IF OBJECT_ID('dbo.olap_member_values', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.olap_member_values (
          id BIGINT IDENTITY(1,1) PRIMARY KEY,
          cube_id INT NOT NULL,
          hierarchy_unique_name NVARCHAR(500) NOT NULL,
          member_unique_name NVARCHAR(500) NOT NULL,
          member_caption NVARCHAR(500) NOT NULL,
          member_caption_normalized NVARCHAR(500) NOT NULL,
          synced_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          CONSTRAINT FK_olap_member_values_cube FOREIGN KEY (cube_id)
            REFERENCES dbo.olap_cubes(id) ON DELETE CASCADE
        );

        CREATE INDEX IX_member_values_lookup
          ON dbo.olap_member_values (cube_id, hierarchy_unique_name, member_caption_normalized);
        CREATE UNIQUE INDEX UX_member_values_unique
          ON dbo.olap_member_values (cube_id, hierarchy_unique_name, member_unique_name);
      END;
    `);

    this.initialized = true;
  }

  private async getReadyPool(): Promise<ConnectionPool> {
    const pool = await getSqlPool();
    await this.ensureTable(pool);
    return pool;
  }

  /**
   * Resuelve un valor de filtro contra los valores precargados en SQL.
   * Scoring idéntico al de mdxBridgeService para garantizar compatibilidad.
   */
  async resolveMemberWithScore(
    catalog: string,
    xmlaCubeName: string,
    hierarchyUniqueName: string,
    rawValue: string
  ): Promise<{ caption: string; uniqueName: string; score: number } | null> {
    const pool = await this.getReadyPool();
    const norm = normalizeText(rawValue);
    if (!norm) return null;

    const result = await pool
      .request()
      .input("catalog", catalog)
      .input("xmlaCubeName", xmlaCubeName)
      .input("hier", hierarchyUniqueName)
      .query<{
        member_caption: string;
        member_unique_name: string;
        member_caption_normalized: string;
      }>(`
        SELECT mv.member_caption, mv.member_unique_name, mv.member_caption_normalized
        FROM dbo.olap_member_values mv
        INNER JOIN dbo.olap_cubes c ON c.id = mv.cube_id
        WHERE c.catalog = @catalog
          AND c.xmla_cube_name = @xmlaCubeName
          AND mv.hierarchy_unique_name = @hier;
      `);

    let best: { caption: string; uniqueName: string; score: number } | null = null;
    for (const row of result.recordset) {
      const captionNorm = row.member_caption_normalized;
      let score = 0;
      if (captionNorm === norm) score += 20;
      if (captionNorm.includes(norm)) score += 10;
      if (captionNorm.startsWith(norm) && norm.length >= 3) score += 8;
      if (norm.includes(captionNorm) && captionNorm.length >= 3) score += 6;

      if (!best || score > best.score) {
        best = { caption: row.member_caption, uniqueName: row.member_unique_name, score };
      }
    }

    return best && best.score > 0 ? best : null;
  }

  async resolveMember(
    catalog: string,
    xmlaCubeName: string,
    hierarchyUniqueName: string,
    rawValue: string
  ): Promise<ResolvedMember | null> {
    const r = await this.resolveMemberWithScore(catalog, xmlaCubeName, hierarchyUniqueName, rawValue);
    return r ? { caption: r.caption, uniqueName: r.uniqueName } : null;
  }

  /**
   * Sincroniza todos los miembros de dimensión desde SSAS a dbo.olap_member_values.
   *
   * Estrategia de rendimiento:
   *  - Usa bulk insert de mssql (mucho más rápido que row-by-row)
   *  - Salta jerarquías que no aportan al filtrado (measures, día, semana)
   *  - Limita miembros por jerarquía a 5000 (evita jerarquías degenerated/exploded)
   *  - Logs detallados por cubo y resumen final
   */
  async syncFromSsas(discoverFn: DiscoverFn): Promise<{ hierarchies: number; members: number }> {
    const pool = await this.getReadyPool();

    const cubesRes = await pool.request().query<{
      id: number;
      catalog: string;
      xmla_cube_name: string;
    }>(`SELECT id, catalog, xmla_cube_name FROM dbo.olap_cubes ORDER BY id`);

    let totalHierarchies = 0;
    let totalMembers = 0;
    const t0 = Date.now();

    console.log(`[memberValues] Iniciando sync de valores para ${cubesRes.recordset.length} cubos`);

    for (const cube of cubesRes.recordset) {
      const cubeT0 = Date.now();
      let cubeMembers = 0;
      let cubeHierarchies = 0;
      let cubeSkipped = 0;

      const hierRes = await pool
        .request()
        .input("cubeId", cube.id)
        .query<{ hierarchy_unique_name: string }>(`
          SELECT hierarchy_unique_name
          FROM dbo.olap_hierarchies
          WHERE cube_id = @cubeId
          ORDER BY hierarchy_unique_name;
        `);

      for (const h of hierRes.recordset) {
        const hierarchy = h.hierarchy_unique_name;

        if (shouldSkipHierarchy(hierarchy)) {
          cubeSkipped++;
          continue;
        }

        let rows: Array<Record<string, string>>;
        try {
          rows = await discoverFn(
            "MDSCHEMA_MEMBERS",
            { CUBE_NAME: cube.xmla_cube_name, HIERARCHY_UNIQUE_NAME: hierarchy },
            cube.catalog
          );
        } catch (err) {
          console.warn(`[memberValues]   [WARN] ${cube.xmla_cube_name}/${hierarchy} -> XMLA error: ${(err as Error).message}`);
          continue;
        }

        // Evitar jerarquías degeneradas (demasiados miembros = jerarquía de fecha a nivel bajo)
        if (rows.length > 5000) {
          console.log(`[memberValues]   [SKIP] ${hierarchy} -> ${rows.length} miembros (demasiados, se omite)`);
          cubeSkipped++;
          continue;
        }

        // Filtrar filas válidas
        const validRows = rows.filter((row) => {
          const uniqueName = row.MEMBER_UNIQUE_NAME ?? "";
          const caption = row.MEMBER_CAPTION ?? row.MEMBER_NAME ?? "";
          return uniqueName && caption;
        });

        if (validRows.length === 0) continue;

        // Borrar datos anteriores de esta jerarquía
        await pool
          .request()
          .input("cubeId", cube.id)
          .input("hier", hierarchy)
          .query(`
            DELETE FROM dbo.olap_member_values
            WHERE cube_id = @cubeId AND hierarchy_unique_name = @hier;
          `);

        // Bulk insert usando mssql Table
        const table = new sql.Table("dbo.olap_member_values");
        table.create = false;
        table.columns.add("cube_id", sql.Int, { nullable: false });
        table.columns.add("hierarchy_unique_name", sql.NVarChar(500), { nullable: false });
        table.columns.add("member_unique_name", sql.NVarChar(500), { nullable: false });
        table.columns.add("member_caption", sql.NVarChar(500), { nullable: false });
        table.columns.add("member_caption_normalized", sql.NVarChar(500), { nullable: false });
        table.columns.add("synced_at", sql.DateTime2, { nullable: false });

        const now = new Date();
        for (const row of validRows) {
          const uniqueName = row.MEMBER_UNIQUE_NAME ?? "";
          const caption = row.MEMBER_CAPTION ?? row.MEMBER_NAME ?? "";
          table.rows.add(cube.id, hierarchy, uniqueName, caption, normalizeText(caption), now);
        }

        try {
          await pool.request().bulk(table);
          cubeMembers += validRows.length;
          totalMembers += validRows.length;
          cubeHierarchies++;
          totalHierarchies++;
        } catch (err) {
          console.warn(`[memberValues]   [WARN] bulk insert falló para ${hierarchy}: ${(err as Error).message}`);
        }
      }

      const elapsedCube = ((Date.now() - cubeT0) / 1000).toFixed(1);
      console.log(
        `[memberValues] [OK] ${cube.catalog}/${cube.xmla_cube_name} -> ${cubeHierarchies} jerarquías, ${cubeMembers} valores, ${cubeSkipped} omitidas (${elapsedCube}s)`
      );
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[memberValues] Sync completado: ${totalHierarchies} jerarquías, ${totalMembers} valores en ${elapsed}s`);

    return { hierarchies: totalHierarchies, members: totalMembers };
  }

  /**
   * Devuelve un resumen de cobertura: cuántos cubos y valores hay cargados.
   * Útil para diagnosticar y para el endpoint de admin.
   */
  async coverage(): Promise<Array<{ catalog: string; cube: string; hierarchies: number; members: number }>> {
    const pool = await this.getReadyPool();
    const result = await pool.request().query<{
      catalog: string;
      cube: string;
      hierarchies: number;
      members: number;
    }>(`
      SELECT
        c.catalog,
        c.xmla_cube_name AS cube,
        COUNT(DISTINCT mv.hierarchy_unique_name) AS hierarchies,
        COUNT(mv.id) AS members
      FROM dbo.olap_cubes c
      LEFT JOIN dbo.olap_member_values mv ON mv.cube_id = c.id
      GROUP BY c.catalog, c.xmla_cube_name
      ORDER BY members DESC;
    `);
    return result.recordset.map((r) => ({
      catalog: r.catalog,
      cube: r.cube,
      hierarchies: Number(r.hierarchies),
      members: Number(r.members),
    }));
  }
}

export const memberValueService = new MemberValueService();
