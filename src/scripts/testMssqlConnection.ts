import sql from "mssql";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildUserCandidates(rawUser: string): string[] {
  return unique([
    rawUser,
    rawUser.replace("\\u", "\\"),
    rawUser.replace("\\\\u", "\\"),
    rawUser.replace(/\\u/g, "\\"),
    rawUser.replace(/\\\\u/g, "\\")
  ]);
}

async function run(): Promise<void> {
  const host = process.env.SQL_TEST_HOST ?? "192.168.100.50";
  const port = Number(process.env.SQL_TEST_PORT ?? "1433");
  const rawUser = process.env.DB_USER ?? "";
  const password = process.env.DB_PWD ?? "";

  if (!rawUser || !password) {
    throw new Error("Missing DB_USER or DB_PWD in environment.");
  }

  const users = buildUserCandidates(rawUser);
  let lastError = "Unknown connection error.";

  for (const user of users) {
    let pool: sql.ConnectionPool | undefined;
    try {
      pool = await sql.connect({
        server: host,
        port,
        user,
        password,
        options: {
          encrypt: false,
          trustServerCertificate: true
        },
        connectionTimeout: 12_000,
        requestTimeout: 20_000
      });

      const result = await pool
        .request()
        .query(
          "SELECT @@SERVERNAME AS server_name, DB_NAME() AS current_db; SELECT name FROM sys.databases ORDER BY name;"
        );

      const recordsets = result.recordsets as any[][];
      const serverInfo = recordsets?.[0]?.[0] ?? {};
      const dbs = (recordsets?.[1] ?? []).map((row) => String(row?.name));

      console.log("SQL_CONNECTION_OK");
      console.log(
        JSON.stringify(
          {
            host,
            port,
            user_used: user,
            server: serverInfo,
            databases_count: dbs.length,
            databases: dbs
          },
          null,
          2
        )
      );
      return;
    } catch (error) {
      lastError = (error as Error).message;
    } finally {
      if (pool) {
        await pool.close().catch(() => undefined);
      }
    }
  }

  throw new Error(lastError);
}

void run().catch((error) => {
  console.error("SQL_CONNECTION_ERR");
  console.error((error as Error).message);
  process.exit(1);
});
