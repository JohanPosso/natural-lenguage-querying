/**
 * Sube las instrucciones de entrenamiento a ambos agentes en Azure AI Foundry.
 *
 * Ejecutar una vez inicialmente, y cada vez que se actualicen los prompts:
 *   npx ts-node src/scripts/trainAgents.ts
 */
import "dotenv/config";
import { trainAgents } from "../services/agentRegistry";

async function run(): Promise<void> {
  console.log("=== Entrenamiento de agentes ===\n");
  console.log("Subiendo instrucciones a Azure AI Foundry...\n");
  await trainAgents();
  console.log("\n[OK] Listo. Ambos agentes tienen sus instrucciones actualizadas.");
  console.log("   - agent-dev360          → Planificador / Intérprete NLU");
  console.log("   - agent-dev360-Worker-1 → Worker / Redactor de respuestas OLAP");
}

void run().catch((err) => {
  console.error("[ERROR] Error durante el entrenamiento:", (err as Error).message);
  process.exit(1);
});
