/**
 * Script de sincronización del catálogo OLAP hacia SQL Server.
 *
 * Uso:  npm run sync-catalog
 *
 * Qué hace:
 *   1. Conecta al endpoint XMLA (SSAS)
 *   2. Descubre todos los catálogos, cubos, medidas, dimensiones y jerarquías
 *   3. Guarda/actualiza todo en dbo.olap_cubes, dbo.olap_members, dbo.olap_hierarchies
 *
 * Ejecutar al:
 *   - Arrancar por primera vez el proyecto
 *   - Cuando se añadan/modifiquen cubos en SSAS
 *   - Programar como tarea periódica (cron) si los cubos cambian con frecuencia
 */

import dotenv from "dotenv";
dotenv.config();

import { catalogService } from "../services/catalogService";
import { xmlaSyncService } from "../services/xmlaSyncService";

async function main() {
  console.log("=".repeat(60));
  console.log("SINCRONIZACIÓN DE CATÁLOGO OLAP -> SQL SERVER");
  console.log("=".repeat(60));
  console.log(`Endpoint XMLA: ${process.env.XMLA_ENDPOINT}`);
  console.log(`Base de datos: ${process.env.DATABASE_URL?.split(";")[0]}`);
  console.log("");

  const t0 = Date.now();

  try {
    const result = await catalogService.syncFromSsas(
      (requestType, restrictions, catalog) =>
        xmlaSyncService.discoverRows(requestType, restrictions, catalog)
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("");
    console.log("=".repeat(60));
    console.log(`[OK] Sincronización completada en ${elapsed}s`);
    console.log(`   Cubos:       ${result.cubes}`);
    console.log(`   Miembros:    ${result.members}`);
    console.log(`   Jerarquías:  ${result.hierarchies}`);
    console.log("=".repeat(60));
    process.exit(0);
  } catch (err) {
    console.error("");
    console.error("[ERROR] Error durante la sincronización:");
    console.error((err as Error).message);
    process.exit(1);
  }
}

main();
