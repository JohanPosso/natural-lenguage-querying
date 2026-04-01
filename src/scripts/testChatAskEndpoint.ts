/**
 * Prueba manual del endpoint POST /api/chat/ask (persistencia + pipeline completo).
 *
 * Uso (con el API levantado: npm run dev):
 *   npx ts-node src/scripts/testChatAskEndpoint.ts
 *
 * Variables opcionales:
 *   CHAT_TEST_BASE_URL=http://localhost:3000  (por defecto PUBLIC_URL o localhost:3000)
 *   CHAT_TEST_QUESTION="tu pregunta"
 */

import "dotenv/config";
import { env } from "../config/env";

const base =
  process.env.CHAT_TEST_BASE_URL?.replace(/\/$/, "") ||
  env.publicUrl ||
  "http://localhost:3000";

const question =
  process.env.CHAT_TEST_QUESTION?.trim() ||
  "¿Cuántas matriculaciones de mercado total hubo en 2024? Responde en una frase.";

async function main(): Promise<void> {
  const url = `${base}/api/chat/ask`;
  console.log(`POST ${url}`);
  console.log(`Pregunta: ${question}\n`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.DEV_TEST_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    console.log("(Authorization: Bearer <DEV_TEST_TOKEN>)\n");
  } else {
    console.log(
      "(Sin Authorization: el servidor usará DEV_TEST_TOKEN del .env si está definido)\n"
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ question })
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("Respuesta no JSON:", text.slice(0, 500));
    process.exit(1);
  }

  console.log(`HTTP ${res.status}`);
  const body = json as Record<string, unknown>;
  if (body.conversation_id) {
    console.log(`conversation_id: ${body.conversation_id}`);
  }
  if (body.data && typeof body.data === "object") {
    const data = body.data as Record<string, unknown>;
    console.log(`cubo: ${data.cube ?? "-"}`);
    console.log(`medida: ${data.measure ?? "-"}`);
  }
  if (typeof body.answer === "string") {
    console.log(`\nanswer (extracto):\n${body.answer.slice(0, 800)}${body.answer.length > 800 ? "…" : ""}`);
  }
  if (!res.ok) {
    console.error("\nError:", body);
    process.exit(1);
  }
  console.log("\nOK — revisa logs/ask-debug.jsonl para query_plan_corrected, resolved_filters, pipeline_success.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
