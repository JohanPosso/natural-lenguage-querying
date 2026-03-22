/**
 * Azure AI Projects client wrapper.
 *
 * Estrategia de autenticación (en orden de prioridad):
 *
 *  1. ClientSecretCredential  — si AZURE_CLIENT_ID + AZURE_CLIENT_SECRET están en .env
 *                               ✅ Funciona en servidores on-premise Windows sin az/VS Code.
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
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { env } from "../config/env";

class AzureAiProjectsService {
  isConfigured(): boolean {
    return Boolean(env.azureExistingAiProjectEndpoint);
  }

  /**
   * Selecciona la credencial óptima según las variables de entorno disponibles.
   * ClientSecretCredential es obligatorio en servidores sin az CLI ni VS Code.
   */
  private buildCredential() {
    const { azureTenantId, azureClientId, azureClientSecret } = env;

    if (azureTenantId && azureClientId && azureClientSecret) {
      console.log("[AzureAI] Usando ClientSecretCredential (Service Principal)");
      return new ClientSecretCredential(azureTenantId, azureClientId, azureClientSecret);
    }

    console.log("[AzureAI] Usando DefaultAzureCredential (entorno de desarrollador)");
    return new DefaultAzureCredential({
      tenantId: azureTenantId,
      processTimeoutInMs: 15_000
    });
  }

  getProjectClient(): AIProjectClient {
    if (!env.azureExistingAiProjectEndpoint) {
      throw new Error("Falta AZURE_EXISTING_AIPROJECT_ENDPOINT en las variables de entorno.");
    }
    return new AIProjectClient(env.azureExistingAiProjectEndpoint, this.buildCredential());
  }

  /** Returns an OpenAI-compatible client backed by the Azure AI Projects endpoint */
  getOpenAICompatibleClient() {
    return this.getProjectClient().getOpenAIClient();
  }
}

export const azureAiProjectsService = new AzureAiProjectsService();
