import { randomUUID } from "crypto";
import type { ConnectionPool } from "mssql";
import axios from "axios";
import { getSqlPool } from "./sqlServerClient";
import { env } from "../config/env";

export type CustomerRule = {
  id: string;
  customer_id: string;
  name: string;
  content: string;
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
};

class CustomerRulesService {
  private initialized = false;

  private async ensureTable(pool: ConnectionPool): Promise<void> {
    if (this.initialized) return;

    await pool.request().query(`
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
      END;
    `);

    this.initialized = true;
  }

  private async getReadyPool(): Promise<ConnectionPool> {
    const pool = await getSqlPool();
    await this.ensureTable(pool);
    return pool;
  }

  private rowToRule(row: Record<string, unknown>): CustomerRule {
    return {
      id: String(row.id),
      customer_id: String(row.customer_id),
      name: String(row.name),
      content: String(row.content),
      is_active: Boolean(row.is_active),
      priority: Number(row.priority),
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at:
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      created_by_user_id: row.created_by_user_id != null ? String(row.created_by_user_id) : null
    };
  }

  async listByCustomer(customerId: string, limit = 200): Promise<CustomerRule[]> {
    const pool = await this.getReadyPool();
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const cid = customerId.trim();
    if (!cid) return [];

    const result = await pool
      .request()
      .input("customerId", cid)
      .input("limit", safeLimit)
      .query(`
        SELECT TOP (@limit)
          id, customer_id, name, content, is_active, priority, created_by_user_id, created_at, updated_at
        FROM dbo.customer_rules
        WHERE customer_id = @customerId
        ORDER BY is_active DESC, priority ASC, updated_at DESC;
      `);

    return result.recordset.map((row) => this.rowToRule(row as Record<string, unknown>));
  }

  async listActiveForPrompt(customerId: string | null | undefined, limit = 500): Promise<CustomerRule[]> {
    const cid = String(customerId ?? "").trim();
    if (!cid) return [];

    const pool = await this.getReadyPool();
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const result = await pool
      .request()
      .input("customerId", cid)
      .input("limit", safeLimit)
      .query(`
        SELECT TOP (@limit)
          id, customer_id, name, content, is_active, priority, created_by_user_id, created_at, updated_at
        FROM dbo.customer_rules
        WHERE customer_id = @customerId AND is_active = 1
        ORDER BY priority ASC, updated_at DESC;
      `);

    return result.recordset.map((row) => this.rowToRule(row as Record<string, unknown>));
  }

  /**
   * Bloque de texto para prompts del agente (vacío si no hay reglas o sin customerId).
   */
  async buildPromptBlock(customerId: string | null | undefined): Promise<string> {
    const active = await this.listActiveForPrompt(customerId, 500);
    if (active.length === 0) return "";

    const lines = [
      "=== REGLAS ESPECÍFICAS DEL CLIENTE (desde base de datos) ===",
      ...active.map((r, i) => `${i + 1}. [${r.name}] ${r.content}`),
      "==========================================================="
    ];
    return lines.join("\n");
  }

  async getById(id: string): Promise<CustomerRule | null> {
    const pool = await this.getReadyPool();
    const result = await pool
      .request()
      .input("id", id)
      .query(`
        SELECT id, customer_id, name, content, is_active, priority, created_by_user_id, created_at, updated_at
        FROM dbo.customer_rules
        WHERE id = @id;
      `);

    const row = result.recordset[0];
    if (!row) return null;
    return this.rowToRule(row as Record<string, unknown>);
  }

  async create(input: {
    customer_id: string;
    name: string;
    content: string;
    is_active?: boolean;
    priority?: number;
    created_by_user_id: string;
  }): Promise<CustomerRule> {
    const pool = await this.getReadyPool();
    const id = randomUUID();
    const customer_id = input.customer_id.trim();
    const name = input.name.trim();
    const content = input.content.trim();
    const isActive = input.is_active ?? true;
    const priority = Number.isFinite(input.priority) ? Number(input.priority) : 100;

    await pool
      .request()
      .input("id", id)
      .input("customerId", customer_id)
      .input("name", name)
      .input("content", content)
      .input("isActive", isActive)
      .input("priority", priority)
      .input("createdBy", input.created_by_user_id)
      .query(`
        INSERT INTO dbo.customer_rules (id, customer_id, name, content, is_active, priority, created_by_user_id, updated_at)
        VALUES (@id, @customerId, @name, @content, @isActive, @priority, @createdBy, SYSUTCDATETIME());
      `);

    const created = await this.getById(id);
    if (!created) throw new Error("No se pudo crear la regla de cliente.");
    return created;
  }

  async update(
    id: string,
    patch: Partial<Pick<CustomerRule, "name" | "content" | "is_active" | "priority">>
  ): Promise<CustomerRule | null> {
    const pool = await this.getReadyPool();
    const current = await this.getById(id);
    if (!current) return null;

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    const content = patch.content !== undefined ? patch.content.trim() : current.content;
    const isActive = patch.is_active !== undefined ? Boolean(patch.is_active) : current.is_active;
    const priority = patch.priority !== undefined ? Number(patch.priority) : current.priority;

    await pool
      .request()
      .input("id", id)
      .input("name", name)
      .input("content", content)
      .input("isActive", isActive)
      .input("priority", priority)
      .query(`
        UPDATE dbo.customer_rules
        SET
          name = @name,
          content = @content,
          is_active = @isActive,
          priority = @priority,
          updated_at = SYSUTCDATETIME()
        WHERE id = @id;
      `);

    return this.getById(id);
  }

  async remove(id: string): Promise<boolean> {
    const pool = await this.getReadyPool();
    const result = await pool
      .request()
      .input("id", id)
      .query(`
        DELETE FROM dbo.customer_rules
        WHERE id = @id;
        SELECT @@ROWCOUNT AS affected;
      `);
    return Number(result.recordset?.[0]?.affected ?? 0) > 0;
  }
}

export const customerRulesService = new CustomerRulesService();

// -- Validación contra Launcher (lista products del cliente) -------------------

type LauncherCustomerResponse = {
  success?: boolean;
  data?: {
    customer?: {
      id?: string;
      products?: string[];
    };
  };
};

/**
 * Comprueba si el cliente tiene el producto NLQ (PRODUCT_ID) en su lista de products.
 */
export async function customerHasNlqProduct(token: string, customerId: string): Promise<boolean> {
  if (!env.apiLauncherEndpoint || !env.productId) {
    throw new Error("API_LAUNCHER_ENDPOINT o PRODUCT_ID no están configurados.");
  }

  const base = env.apiLauncherEndpoint.replace(/\/$/, "");
  const url = `${base}/customers/${encodeURIComponent(customerId.trim())}`;

  const response = await axios.get<LauncherCustomerResponse>(url, {
    headers: { Token: token },
    timeout: 12_000,
    validateStatus: (s) => s === 200 || s === 404
  });

  if (response.status !== 200 || !response.data?.data?.customer) {
    return false;
  }

  const products = response.data.data.customer.products ?? [];
  return products.map(String).includes(String(env.productId));
}
