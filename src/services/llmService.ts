/**
 * Servicio LLM unificado — Azure AI Foundry (via agentRegistry).
 *
 * A partir de esta versión, solo se usa Azure AI Projects.
 * OpenAI directo ha sido eliminado del pipeline.
 *
 * Para llamadas genéricas (sin agente específico) usa el agente planificador
 * como default, ya que ambos comparten el mismo deployment gpt-4.1.
 */
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";
import axios from "axios";
import { env } from "../config/env";

const AI_SCOPE = "https://ai.azure.com/.default";
const RESPONSES_API_VERSION = "2025-11-15-preview";

type ChatClientContext = { deployment: string; baseURL: string };
let _ctxCache: ChatClientContext | null = null;
let _credential: DefaultAzureCredential | null = null;

function isDirectAzureOAIConfigured(): boolean {
  return Boolean(
    env.azureEndpoint &&
      env.azureApiKey &&
      env.azureChatDeployment &&
      !env.azureEndpoint.includes("your-resource") &&
      !env.azureApiKey.includes("your_azure") &&
      !env.azureChatDeployment.includes("deployment-name")
  );
}

async function discoverDeploymentName(projectClient: AIProjectClient): Promise<string> {
  if (env.azureChatDeployment && !env.azureChatDeployment.includes("deployment-name")) {
    return env.azureChatDeployment;
  }
  try {
    const found: Array<{ name?: string; model?: { name?: string } }> = [];
    for await (const dep of projectClient.deployments.list()) {
      found.push(dep as { name?: string; model?: { name?: string } });
    }
    const preferred =
      found.find((d) => ((d.name ?? d.model?.name) || "").toLowerCase().startsWith("gpt-4")) ??
      found[0];
    const name = preferred?.name ?? preferred?.model?.name;
    if (name) {
      console.log(`[llmService] Auto-discovered deployment: ${name}`);
      return name;
    }
  } catch (err) {
    console.warn("[llmService] Could not list deployments:", (err as Error).message);
  }
  return "gpt-4.1";
}

function getCredential(): DefaultAzureCredential {
  if (!_credential) {
    _credential = new DefaultAzureCredential({ tenantId: env.azureTenantId });
  }
  return _credential;
}

async function getContext(): Promise<ChatClientContext> {
  if (_ctxCache) return _ctxCache;

  if (!env.azureExistingAiProjectEndpoint) {
    throw new Error(
      "LLM no configurado. Define AZURE_EXISTING_AIPROJECT_ENDPOINT en el .env."
    );
  }

  const credential = getCredential();
  const projectClient = new AIProjectClient(env.azureExistingAiProjectEndpoint, credential);
  const deployment = await discoverDeploymentName(projectClient);
  const baseURL = env.azureExistingAiProjectEndpoint.replace(/\/$/, "");

  console.log(`[llmService] Azure AI Projects — deployment: ${deployment}`);
  _ctxCache = { deployment, baseURL };
  return _ctxCache;
}

async function callResponsesApi(
  systemInstructions: string,
  userInput: string,
  deployment: string,
  baseURL: string,
  token: string
): Promise<string> {
  const url = `${baseURL}/openai/responses?api-version=${RESPONSES_API_VERSION}`;

  const body = {
    model: deployment,
    instructions: systemInstructions,
    input: userInput,
  };

  const response = await axios.post<{
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    output_text?: string;
    error?: { code: string; message: string };
  }>(url, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    timeout: env.requestTimeoutMs,
  });

  const data = response.data;

  if (data.error) {
    throw new Error(`Responses API error: ${data.error.code} — ${data.error.message}`);
  }

  if (data.output_text) return data.output_text.trim();

  for (const outputItem of data.output ?? []) {
    if (outputItem.type === "message") {
      for (const contentItem of outputItem.content ?? []) {
        if (contentItem.type === "output_text" && contentItem.text) {
          return contentItem.text.trim();
        }
      }
    }
  }

  throw new Error("Responses API returned no text output.");
}

// ── Public types ──────────────────────────────────────────────────────────────

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionOptions = {
  temperature?: number;
  model?: string;
  jsonMode?: boolean;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 8000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LlmService {
  resetCache(): void {
    _ctxCache = null;
    _credential = null;
  }

  async chatCompletion(
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<string>;

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    temperature?: number
  ): Promise<string>;

  async chatCompletion(
    messagesOrSystem: ChatMessage[] | string,
    userPromptOrOptions?: string | CompletionOptions,
    legacyTemperature?: number
  ): Promise<string> {
    let messages: ChatMessage[];
    let temperature: number;
    let modelOverride: string | undefined;

    if (Array.isArray(messagesOrSystem)) {
      const opts = (userPromptOrOptions as CompletionOptions) ?? {};
      messages = messagesOrSystem;
      temperature = opts.temperature ?? 0;
      modelOverride = opts.model || undefined;
    } else {
      messages = [
        { role: "system", content: messagesOrSystem },
        { role: "user", content: userPromptOrOptions as string },
      ];
      temperature = legacyTemperature ?? 0;
      modelOverride = undefined;
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._doCompletion(messages, temperature, modelOverride);
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message ?? "";
        const status = (err as { response?: { status?: number } }).response?.status;

        const isRetryable =
          status === 429 ||
          status === 503 ||
          status === 500 ||
          msg.includes("429") ||
          msg.includes("rate") ||
          msg.includes("throttle");

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(
            `[llmService] Rate limited (attempt ${attempt}/${MAX_RETRIES}). ` +
              `Retrying in ${delay / 1000}s...`
          );
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error("LLM max retries exceeded");
  }

  private async _doCompletion(
    messages: ChatMessage[],
    temperature: number,
    modelOverride?: string
  ): Promise<string> {
    // Fallback opcional: Azure OpenAI directo con API key
    if (isDirectAzureOAIConfigured()) {
      const model = modelOverride || env.azureChatDeployment!;
      const client = new AzureOpenAI({
        endpoint: env.azureEndpoint!,
        apiKey: env.azureApiKey!,
        apiVersion: "2024-10-21",
      });
      const response = await client.chat.completions.create({ model, messages, temperature });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error("Azure OpenAI directo devolvió respuesta vacía.");
      console.log(`[llmService] ✦ Azure OpenAI directo — ${model}`);
      return content;
    }

    // Principal: Azure AI Projects Responses API
    const { deployment, baseURL } = await getContext();
    const usedDeployment = modelOverride || deployment;
    const credential = getCredential();
    const tokenProvider = getBearerTokenProvider(credential, AI_SCOPE);
    const token = await tokenProvider();

    const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
    const userInput = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");

    console.log(`[llmService] ✦ Azure AI Projects — ${usedDeployment}`);
    return callResponsesApi(systemMsg, userInput, usedDeployment, baseURL, token);
  }

  extractJson(raw: string): string {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];
    const bare = raw.match(/(\{[\s\S]*\})/);
    if (bare) return bare[1];
    return raw;
  }

  async jsonCompletion<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const raw = await this.chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0 }
    );
    const jsonStr = this.extractJson(raw);
    try {
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      throw new Error(
        `LLM devolvió JSON inválido: ${(err as Error).message}. Respuesta: ${raw.slice(0, 300)}`
      );
    }
  }
}

export const llmService = new LlmService();
