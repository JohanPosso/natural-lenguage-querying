/**
 * Prueba ambos agentes de forma aislada.
 *
 * Uso:
 *   npx ts-node src/scripts/testAgents.ts
 *   npx ts-node src/scripts/testAgents.ts "cuántas matriculaciones Ford en 2026"
 */
import "dotenv/config";
import { planQuery } from "../services/plannerAgent";
import { buildResponse } from "../services/workerAgent";
import { env } from "../config/env";

async function run(): Promise<void> {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "cuántas matriculaciones hay de Ford en 2026";

  console.log("=== Test de ambos agentes ===\n");
  console.log(`Planner ID : ${env.azurePlannerAgentId}`);
  console.log(`Worker ID  : ${env.azureWorkerAgentId}`);
  console.log(`Pregunta   : ${question}\n`);

  // -- Agente 1: Planificador ----------------------------------------------
  console.log("--- AGENTE 1: Planificador ---");
  let plan;
  try {
    plan = await planQuery(question);
    console.log("[OK] Plan generado:");
    console.log(JSON.stringify(plan, null, 2));
  } catch (err) {
    console.error("[ERROR] Error en Planificador:", (err as Error).message);
    process.exit(1);
  }

  // -- Agente 2: Worker (con datos de prueba simulados) --------------------
  console.log("\n--- AGENTE 2: Worker (datos simulados) ---");
  try {
    const fakeResults = [
      {
        friendly_name: "Matriculaciones YTD",
        cube_name: "Cubo Ford",
        value: "252873",
        applied_filters: [{ dimension: "Fecha.Año", value: plan.year ?? "2026" }],
        unresolved_filter_hints: [],
      },
    ];

    const answer = await buildResponse({
      question,
      language: plan.language,
      year: plan.year,
      results: fakeResults,
    });

    console.log("[OK] Respuesta generada:");
    console.log(answer);
  } catch (err) {
    console.error("[ERROR] Error en Worker:", (err as Error).message);
    process.exit(1);
  }

  console.log("\n[OK] Ambos agentes funcionan correctamente.");
}

void run().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
