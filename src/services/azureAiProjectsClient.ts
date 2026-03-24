/**
 * Azure AI Projects client wrapper.
 *
 * Estrategia de autenticación (en orden de prioridad):
 *
 *  1. ClientSecretCredential  — si AZURE_CLIENT_ID + AZURE_CLIENT_SECRET están en .env
 *                               [OK] Funciona en servidores on-premise Windows sin az/VS Code.
 *
 *  2. DefaultAzureCredential  — fallback para entornos de desarrollador (az CLI, VS Code,
 *                               Managed Identity en Azure, PowerShell Az…).
 *
 * Para usar la opción 1, añadir al .env:
 *   AZURE_CLIENT_ID=<Application (client) ID del App Registration>
 *   AZURE_CLIENT_SECRET=<Client Secret del App Registration>
 *   AZURE_TENANT_ID=<Tenant ID> (ya debe estar)
 */
import { AIProjectClient } from "@azure/ai-projects";
import { env } from "../config/env";
import { buildAzureCredential } from "./azureCredential";

class AzureAiProjectsService {
  isConfigured(): boolean {
    return Boolean(env.azureExistingAiProjectEndpoint);
  }

  getProjectClient(): AIProjectClient {
    if (!env.azureExistingAiProjectEndpoint) {
      throw new Error("Falta AZURE_EXISTING_AIPROJECT_ENDPOINT en las variables de entorno.");
    }
    return new AIProjectClient(env.azureExistingAiProjectEndpoint, buildAzureCredential());
  }

  /** Returns an OpenAI-compatible client backed by the Azure AI Projects endpoint */
  getOpenAICompatibleClient() {
    return this.getProjectClient().getOpenAIClient();
  }
}

export const azureAiProjectsService = new AzureAiProjectsService();
