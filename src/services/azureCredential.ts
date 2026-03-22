/**
 * Fábrica centralizada de credenciales Azure AD.
 *
 * Selecciona automáticamente la mejor estrategia según el entorno:
 *
 *  AZURE_AUTH_METHOD=device_code       → DeviceCodeCredential
 *    Al arrancar el servidor imprime en consola:
 *    "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter code XXXXXXXX"
 *    El usuario abre esa URL en cualquier navegador (puede ser desde otro PC), introduce el código
 *    y el servidor queda autenticado. No requiere internet en el servidor, solo acceso a login.microsoftonline.com.
 *
 *  AZURE_CLIENT_ID + AZURE_CLIENT_SECRET → ClientSecretCredential (Service Principal)
 *    Para servidores on-premise sin az CLI, VS Code ni acceso a internet general.
 *    Requiere un App Registration en el mismo tenant que el recurso Azure AI.
 *
 *  (ninguna de las anteriores) → DefaultAzureCredential
 *    Para entornos de desarrollador con az CLI, VS Code o Managed Identity en Azure.
 */

import {
  ClientSecretCredential,
  DefaultAzureCredential,
  DeviceCodeCredential,
  type TokenCredential,
} from "@azure/identity";
import { env } from "../config/env";

let _credential: TokenCredential | null = null;

export function buildAzureCredential(): TokenCredential {
  if (_credential) return _credential;

  const { azureTenantId, azureClientId, azureClientSecret, azureAuthMethod } = env;

  // 1. Device Code — para servidores sin internet ni herramientas Azure instaladas
  if (azureAuthMethod === "device_code") {
    console.log(
      "[AzureAI] Usando DeviceCodeCredential — sigue las instrucciones en consola para autenticarte"
    );
    _credential = new DeviceCodeCredential({
      tenantId: azureTenantId,
      userPromptCallback: (info) => {
        console.log("\n╔══════════════════════════════════════════════════════╗");
        console.log("║         AUTENTICACIÓN AZURE REQUERIDA                ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log(`║  1. Abre en cualquier navegador:                     ║`);
        console.log(`║     https://microsoft.com/devicelogin                ║`);
        console.log(`║  2. Introduce el código: ${info.userCode.padEnd(27)}║`);
        console.log(`║  3. Inicia sesión con tu cuenta corporativa           ║`);
        console.log("╚══════════════════════════════════════════════════════╝\n");
      },
    });
    return _credential;
  }

  // 2. Service Principal — para servidores on-premise con credenciales de App Registration
  if (azureTenantId && azureClientId && azureClientSecret) {
    console.log("[AzureAI] Usando ClientSecretCredential (Service Principal)");
    _credential = new ClientSecretCredential(azureTenantId, azureClientId, azureClientSecret);
    return _credential;
  }

  // 3. DefaultAzureCredential — entorno de desarrollador (az CLI, VS Code, Managed Identity…)
  console.log("[AzureAI] Usando DefaultAzureCredential (az CLI / VS Code / Managed Identity)");
  _credential = new DefaultAzureCredential({
    tenantId: azureTenantId,
    processTimeoutInMs: 15_000,
  });
  return _credential;
}
