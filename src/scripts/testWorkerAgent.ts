/**
 * Prueba de conexión al nuevo agente Worker (agent-dev360-Worker-1).
 * Envía una pregunta básica y muestra la respuesta.
 *
 * Uso:
 *   npx ts-node src/scripts/testWorkerAgent.ts
 *   npx ts-node src/scripts/testWorkerAgent.ts "tu mensaje de prueba"
 */
import "dotenv/config";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { env } from "../config/env";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 40; // 60 s máximo

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAgentById(
  client: AIProjectClient,
  agentId: string,
  userMessage: string
): Promise<string> {
  // 1. Crear un thread de conversación fresco
  const thread = await (client.agents as any).createThread();
  console.log(`  -> Thread creado: ${thread.id}`);

  // 2. Añadir el mensaje del usuario al thread
  await (client.agents as any).createMessage(thread.id, {
    role: "user",
    content: userMessage,
  });

  // 3. Lanzar el run con el agente indicado
  let run = await (client.agents as any).createRun(thread.id, agentId);
  console.log(`  -> Run iniciado: ${run.id}  estado: ${run.status}`);

  // 4. Esperar a que termine
  let attempts = 0;
  while (
    ["queued", "in_progress", "requires_action"].includes(run.status) &&
    attempts < MAX_POLL_ATTEMPTS
  ) {
    await sleep(POLL_INTERVAL_MS);
    run = await (client.agents as any).getRun(thread.id, run.id);
    process.stdout.write(`\r  -> Esperando... estado: ${run.status.padEnd(20)}`);
    attempts++;
  }
  console.log();

  if (run.status !== "completed") {
    throw new Error(
      `El run terminó con estado inesperado: ${run.status}. ` +
        (run.lastError ? JSON.stringify(run.lastError) : "")
    );
  }

  // 5. Leer el último mensaje del asistente
  const messages = await (client.agents as any).listMessages(thread.id);
  const assistantMsg = (messages.data as any[]).find((m: any) => m.role === "assistant");
  if (!assistantMsg) throw new Error("No se encontró respuesta del asistente en el thread.");

  // Extraer texto del mensaje (puede ser array de content parts)
  const content = assistantMsg.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const textPart = content.find((c: any) => c.type === "text");
    return (textPart?.text?.value ?? textPart?.text ?? JSON.stringify(content)).trim();
  }
  return JSON.stringify(content);
}

async function run(): Promise<void> {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "Responde en una frase breve: ¿cuál es tu función principal en este sistema?";

  console.log("\n=== Test Agente Worker (agent-dev360-Worker-1) ===");
  console.log(`Endpoint  : ${env.azureExistingAiProjectEndpoint ?? "NO CONFIGURADO"}`);
  console.log(`Agente ID : ${env.azureWorkerAgentId || "NO CONFIGURADO"}`);
  console.log(`Pregunta  : ${question}\n`);

  if (!env.azureExistingAiProjectEndpoint) {
    console.error("ERROR: AZURE_EXISTING_AIPROJECT_ENDPOINT no está definido en .env");
    process.exit(1);
  }
  if (!env.azureWorkerAgentId) {
    console.error("ERROR: AZURE_WORKER_AGENT_ID no está definido en .env");
    process.exit(1);
  }

  const credential = new DefaultAzureCredential({ tenantId: env.azureTenantId });
  const client = new AIProjectClient(env.azureExistingAiProjectEndpoint, credential);

  try {
    const answer = await callAgentById(client, env.azureWorkerAgentId, question);
    console.log("\n[OK] WORKER_AGENT_OK");
    console.log("Respuesta:");
    console.log(answer);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error("\n[ERROR] WORKER_AGENT_ERR");
    console.error(msg);

    // Si falla el Agents API, intentar fallback con Responses API
    console.log("\n[fallback] Probando Responses API con el mismo endpoint...");
    try {
      const axios = (await import("axios")).default;
      const { getBearerTokenProvider } = await import("@azure/identity");
      const tokenProvider = getBearerTokenProvider(credential, "https://ai.azure.com/.default");
      const token = await tokenProvider();
      const url = `${env.azureExistingAiProjectEndpoint.replace(/\/$/, "")}/openai/responses?api-version=2025-11-15-preview`;
      const resp = await axios.post(
        url,
        { model: "gpt-4o", instructions: "Eres un asistente útil.", input: question },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 30_000 }
      );
      const text =
        resp.data?.output_text ??
        resp.data?.output?.[0]?.content?.[0]?.text ??
        JSON.stringify(resp.data).slice(0, 200);
      console.log("\n[OK] RESPONSES_API_OK (fallback)");
      console.log("Respuesta:", text);
    } catch (fallbackErr) {
      console.error("[fallback] También falló:", (fallbackErr as Error).message);
    }

    process.exit(1);
  }
}

void run();
