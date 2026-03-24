import { randomUUID } from "crypto";
import type { ConnectionPool } from "mssql";
import { getSqlPool } from "./sqlServerClient";

export type GlobalRule = {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
};

class GlobalRulesService {
  private initialized = false;

  private async ensureTable(pool: ConnectionPool): Promise<void> {
    if (this.initialized) return;

    await pool.request().query(`
      IF OBJECT_ID('dbo.global_rules', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.global_rules (
          id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          content NVARCHAR(MAX) NOT NULL,
          is_active BIT NOT NULL DEFAULT 1,
          priority INT NOT NULL DEFAULT 100,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_global_rules_active_priority
          ON dbo.global_rules (is_active DESC, priority ASC, updated_at DESC);
      END;
    `);

    this.initialized = true;
  }

  private async getReadyPool(): Promise<ConnectionPool> {
    const pool = await getSqlPool();
    await this.ensureTable(pool);
    return pool;
  }

  async list(limit = 200): Promise<GlobalRule[]> {
    const pool = await this.getReadyPool();
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const result = await pool
      .request()
      .input("limit", safeLimit)
      .query(`
        SELECT TOP (@limit)
          id, name, content, is_active, priority, created_at, updated_at
        FROM dbo.global_rules
        ORDER BY is_active DESC, priority ASC, updated_at DESC;
      `);

    return result.recordset.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      content: String(row.content),
      is_active: Boolean(row.is_active),
      priority: Number(row.priority),
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }));
  }

  async create(input: {
    name: string;
    content: string;
    is_active?: boolean;
    priority?: number;
  }): Promise<GlobalRule> {
    const pool = await this.getReadyPool();
    const id = randomUUID();
    const name = input.name.trim();
    const content = input.content.trim();
    const isActive = input.is_active ?? true;
    const priority = Number.isFinite(input.priority) ? Number(input.priority) : 100;

    await pool
      .request()
      .input("id", id)
      .input("name", name)
      .input("content", content)
      .input("isActive", isActive)
      .input("priority", priority)
      .query(`
        INSERT INTO dbo.global_rules (id, name, content, is_active, priority, updated_at)
        VALUES (@id, @name, @content, @isActive, @priority, SYSUTCDATETIME());
      `);

    const created = await this.getById(id);
    if (!created) throw new Error("No se pudo crear la regla global.");
    return created;
  }

  async getById(id: string): Promise<GlobalRule | null> {
    const pool = await this.getReadyPool();
    const result = await pool
      .request()
      .input("id", id)
      .query(`
        SELECT id, name, content, is_active, priority, created_at, updated_at
        FROM dbo.global_rules
        WHERE id = @id;
      `);

    const row = result.recordset[0];
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      content: String(row.content),
      is_active: Boolean(row.is_active),
      priority: Number(row.priority),
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async update(
    id: string,
    patch: Partial<Pick<GlobalRule, "name" | "content" | "is_active" | "priority">>
  ): Promise<GlobalRule | null> {
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
        UPDATE dbo.global_rules
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
        DELETE FROM dbo.global_rules
        WHERE id = @id;
        SELECT @@ROWCOUNT AS affected;
      `);
    return Number(result.recordset?.[0]?.affected ?? 0) > 0;
  }
}

export const globalRulesService = new GlobalRulesService();

