import sql from "mssql";
import { env } from "../config/env";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

function getConfig(): sql.config {
  if (!env.cubejsDbHost || !env.cubejsDbUser || !env.cubejsDbPass || !env.cubejsDbName) {
    throw new Error(
      "Missing SQL Server credentials. Configure CUBEJS_DB_HOST/CUBEJS_DB_USER/CUBEJS_DB_PASS/CUBEJS_DB_NAME or DATABASE_URL."
    );
  }

  return {
    server: env.cubejsDbHost,
    port: env.cubejsDbPort,
    user: env.cubejsDbUser,
    password: env.cubejsDbPass,
    database: env.cubejsDbName,
    options: {
      encrypt: env.cubejsDbSsl,
      trustServerCertificate: env.cubejsDbTrustServerCertificate
    },
    requestTimeout: env.requestTimeoutMs,
    connectionTimeout: env.requestTimeoutMs
  };
}

export async function getSqlPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(getConfig()).connect();
  }
  return poolPromise;
}
