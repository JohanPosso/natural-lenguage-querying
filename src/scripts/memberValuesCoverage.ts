/**
 * Muestra cobertura de dbo.olap_member_values por cubo (jerarquías y filas).
 * Ejecutar tras sync de catálogo / member values para comprobar huecos.
 */

import "dotenv/config";
import { memberValueService } from "../services/memberValueService";

async function main(): Promise<void> {
  const rows = await memberValueService.coverage();
  const totalMembers = rows.reduce((a, r) => a + r.members, 0);
  const totalHier = rows.reduce((a, r) => a + r.hierarchies, 0);

  console.log("Cobertura olap_member_values (SQL)\n");
  console.log(
    `${"Catálogo".padEnd(28)} ${"Cubo XMLA".padEnd(36)} ${"Jerarq".padStart(6)} ${"Miembros".padStart(10)}`
  );
  console.log("-".repeat(90));
  for (const r of rows) {
    const warn = r.members === 0 ? "  <-- sin valores" : "";
    console.log(
      `${r.catalog.padEnd(28)} ${r.cube.padEnd(36)} ${String(r.hierarchies).padStart(6)} ${String(r.members).padStart(10)}${warn}`
    );
  }
  console.log("-".repeat(90));
  console.log(`Total: ${rows.length} cubos, ${totalHier} jerarquías con datos, ${totalMembers} filas de miembros.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
