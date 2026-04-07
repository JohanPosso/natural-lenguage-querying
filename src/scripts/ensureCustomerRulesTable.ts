/**
 * Crea dbo.customer_rules si no existe (misma definición que customerRulesService).
 * Uso: npx ts-node src/scripts/ensureCustomerRulesTable.ts
 */
import dotenv from "dotenv";
import sql from "mssql";

dotenv.config();

async function run(): Promise<void> {
  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT ?? 1433);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  const encrypt = process.env.DB_ENCRYPT === "true";
  const trust = process.env.DB_TRUST_SERVER_CERT !== "false";

  if (!host || !user || !password || !database) {
    throw new Error("Faltan DB_HOST, DB_USER, DB_PASSWORD o DB_NAME en .env");
  }

  const pool = await sql.connect({
    server: host,
    port,
    user,
    password,
    database,
    options: { encrypt, trustServerCertificate: trust },
    connectionTimeout: 20_000,
    requestTimeout: 30_000
  });

  try {
    const ddl = await pool.request().query<{ status: string }>(`
      IF OBJECT_ID('dbo.customer_rules', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.customer_rules (
          id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
          customer_id NVARCHAR(64) NOT NULL,
          name NVARCHAR(255) NOT NULL,
          content NVARCHAR(MAX) NOT NULL,
          is_active BIT NOT NULL DEFAULT 1,
          priority INT NOT NULL DEFAULT 100,
          created_by_user_id NVARCHAR(64) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_customer_rules_customer_active_priority
          ON dbo.customer_rules (customer_id, is_active DESC, priority ASC, updated_at DESC);
        SELECT 'created' AS [status];
      END
      ELSE
        SELECT 'exists' AS [status];
    `);
    const status = ddl.recordset?.[0]?.status ?? "?";
    console.log("ensureCustomerRulesTable:", status);
  } finally {
    await pool.close();
  }
}

void run().catch((e) => {
  console.error(e);
  process.exit(1);
});
