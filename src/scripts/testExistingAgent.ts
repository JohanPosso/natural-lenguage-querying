import "dotenv/config";
import { llmService } from "../services/llmService";

async function run(): Promise<void> {
  try {
    const prompt =
      process.argv.slice(2).join(" ").trim() ||
      "Responde en una frase corta: ¿cuál es tu función principal?";

    console.log("Sending prompt to LLM:", prompt);
    const answer = await llmService.chatCompletion(
      "Eres un asistente útil. Responde de forma breve en español.",
      prompt
    );
    console.log("LLM_OK");
    console.log("Answer:", answer);
  } catch (error) {
    console.error("LLM_ERR");
    console.error((error as Error).message);
    process.exit(1);
  }
}

void run();
