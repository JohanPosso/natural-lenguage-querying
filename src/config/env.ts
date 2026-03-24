import dotenv from "dotenv";

dotenv.config();

type ParsedSqlServerUrl = {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
};

function parseSqlServerDatabaseUrl(raw?: string): ParsedSqlServerUrl {
  if (!raw) {
    return {};
  }

  const match = raw.match(/^sqlserver:\/\/([^:;\/]+)(?::(\d+))?;(.*)$/i);
  if (!match) {
    return {};
  }

  const [, host, portRaw, paramsRaw] = match;
  const params = new Map<string, string>();
  for (const token of paramsRaw.split(";")) {
    const [k, ...rest] = token.split("=");
    if (!k || rest.length === 0) {
      continue;
    }
    params.set(k.trim().toLowerCase(), rest.join("=").trim());
  }

  const encryptValue = params.get("encrypt")?.toLowerCase();
  const trustValue = params.get("trustservercertificate")?.toLowerCase();

  return {
    host,
    port: portRaw ? Number(portRaw) : undefined,
    user: params.get("user"),
    password: params.get("password"),
    database: params.get("database"),
    encrypt: encryptValue ? encryptValue === "true" : undefined,
    trustServerCertificate: trustValue ? trustValue === "true" : undefined
  };
}

const parsedDbUrl = parseSqlServerDatabaseUrl(process.env.DATABASE_URL);

export const env = {
  port: Number(process.env.PORT ?? 3000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000),
  // URL pública del servidor, sin barra final. Obligatoria en el .env.
  // Ejemplo: PUBLIC_URL=http://192.168.100.47:8000
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
  
  // -- CORS -----------------------------------------------------------------
  // Lista separada por comas con los orígenes permitidos para el frontend.
  // Ej:
  //   CORS_ALLOWED_ORIGINS=http://localhost:5173,http://mi-dominio.com
  // Usar '*' para permitir cualquier origen (útil para dev).
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? "*",

  // -- Autenticación API Launcher --------------------------------------------
  apiLauncherEndpoint: process.env.API_LAUNCHER_ENDPOINT ?? "",
  productId: process.env.PRODUCT_ID ?? "",
  bypassAuth: process.env.BYPASS_AUTH === "true",
  devTestToken: process.env.DEV_TEST_TOKEN ?? "",

  // -- Base de datos SQL Server (chat persistence) ---------------------------
  // Prioridad: DB_HOST/DB_* > DATABASE_URL (parsedDbUrl) > CUBEJS_DB_*
  databaseUrl: process.env.DATABASE_URL,
  cubejsDbHost:
    process.env.DB_HOST ?? parsedDbUrl.host ?? process.env.CUBEJS_DB_HOST,
  cubejsDbPort:
    Number(process.env.DB_PORT ?? parsedDbUrl.port ?? process.env.CUBEJS_DB_PORT ?? 1433),
  cubejsDbName:
    process.env.DB_NAME ?? parsedDbUrl.database ?? process.env.CUBEJS_DB_NAME,
  cubejsDbUser:
    process.env.DB_USER ?? parsedDbUrl.user ?? process.env.CUBEJS_DB_USER,
  cubejsDbPass:
    process.env.DB_PASSWORD ?? parsedDbUrl.password ?? process.env.CUBEJS_DB_PASS,
  cubejsDbSsl:
    process.env.DB_ENCRYPT !== undefined
      ? process.env.DB_ENCRYPT === "true"
      : process.env.CUBEJS_DB_SSL !== undefined
        ? process.env.CUBEJS_DB_SSL === "true"
        : (parsedDbUrl.encrypt ?? false),
  cubejsDbTrustServerCertificate:
    process.env.DB_TRUST_SERVER_CERT !== undefined
      ? process.env.DB_TRUST_SERVER_CERT === "true"
      : (parsedDbUrl.trustServerCertificate ?? true),

  // -- XMLA / SSAS -----------------------------------------------------------
  xmlaEndpoint: process.env.XMLA_ENDPOINT ?? process.env.ISAPI_ENDPOINT ?? "",
  xmlaUser: process.env.XMLA_USER ?? process.env.DB_USER ?? "",
  xmlaPassword: process.env.XMLA_PWD ?? process.env.DB_PWD ?? "",
  xmlaCatalog: process.env.XMLA_CATALOG,

  // -- Azure AI Projects ---------------------------------------------------
  // Endpoint del proyecto (compartido por ambos agentes)
  azureExistingAiProjectEndpoint: process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
  azureTenantId:                  process.env.AZURE_TENANT_ID,

  // Service Principal — necesario en servidores sin az/VS Code/PowerShell Az
  // Se obtiene desde el App Registration en Azure Active Directory:
  //   AZURE_CLIENT_ID     = Application (client) ID del App Registration
  //   AZURE_CLIENT_SECRET = Client secret generado en el App Registration
  azureClientId:     process.env.AZURE_CLIENT_ID,
  azureClientSecret: process.env.AZURE_CLIENT_SECRET,

  // Método de autenticación Azure explícito (opcional).
  // Valores posibles:
  //   "service_principal" -> ClientSecretCredential (requiere CLIENT_ID + CLIENT_SECRET)
  //   "device_code"       -> DeviceCodeCredential (imprime código al arrancar, sin instalar nada)
  //   (vacío)             -> auto: service_principal si hay CLIENT_ID, sino DefaultAzureCredential
  azureAuthMethod: process.env.AZURE_AUTH_METHOD ?? "",

  // Agente 1 — Planificador / Intérprete NLU
  azurePlannerAgentId: process.env.AZURE_PLANNER_AGENT_ID ?? "",
  // Agente 2 — Worker / Redactor de respuestas OLAP
  azureWorkerAgentId:  process.env.AZURE_WORKER_AGENT_ID ?? "",

  // Fallback: Azure OpenAI directo con API key (opcional)
  azureEndpoint:           process.env.AZURE_OPENAI_ENDPOINT,
  azureApiKey:             process.env.AZURE_OPENAI_API_KEY,
  azureChatDeployment:     process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
  azureEmbeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
};
