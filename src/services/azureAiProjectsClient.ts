/**
 * Azure AI Projects client wrapper.
 * This service exposes the Azure AI Projects endpoint as an OpenAI-compatible
 * chat completion interface, using DefaultAzureCredential for authentication.
 *
 * The primary LLM interface is through `llmService.ts`, which uses this
 * client internally when direct Azure OpenAI credentials are not configured.
 */
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { env } from "../config/env";

class AzureAiProjectsService {
  isConfigured(): boolean {
    return Boolean(env.azureExistingAiProjectEndpoint);
  }

  getProjectClient(): AIProjectClient {
    if (!env.azureExistingAiProjectEndpoint) {
      throw new Error("Missing AZURE_EXISTING_AIPROJECT_ENDPOINT.");
    }
    const credential = new DefaultAzureCredential({
      tenantId: env.azureTenantId,
      processTimeoutInMs: 15_000
    });
    return new AIProjectClient(env.azureExistingAiProjectEndpoint, credential);
  }

  /** Returns an OpenAI-compatible client backed by the Azure AI Projects endpoint */
  getOpenAICompatibleClient() {
    return this.getProjectClient().getOpenAIClient();
  }
}

export const azureAiProjectsService = new AzureAiProjectsService();
