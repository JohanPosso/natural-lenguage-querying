/**
 * Test rápido de conexión XMLA + MDX.
 * Uso: npm run test-mdx-bridge -- "SELECT {[Measures].[Matriculaciones]} ON COLUMNS FROM [Matriculaciones]" "Matriculaciones"
 */
import dotenv from "dotenv";
dotenv.config();

import { mdxBridgeService } from "../services/mdxBridgeService";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const mdx = args[0] ?? "SELECT {[Measures].[Matriculaciones]} ON COLUMNS FROM [Matriculaciones]";
  const catalog = args[1] ?? "Matriculaciones";

  console.log("MDX:", mdx);
  console.log("Catalog:", catalog);
  try {
    const result = await mdxBridgeService.executeMdx(mdx, catalog);
    console.log("RESULTADO:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("ERROR:", (err as Error).message);
    process.exit(1);
  }
}

void run();
