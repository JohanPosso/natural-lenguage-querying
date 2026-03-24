import { randomUUID } from "crypto";
import type { ConnectionPool } from "mssql";
import { getSqlPool } from "./sqlServerClient";

export type StoredConversation = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type StoredMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  payload: string | null;
  created_at: string;
};

class ChatPersistenceService {
  private initialized = false;
  private conversationHasTitle = false;
  private messageHasPayload = false;
  private messageHasSequence = false;

  private async ensureTables(pool: ConnectionPool): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create base tables if they don't exist
    await pool.request().query(`
      IF OBJECT_ID('dbo.conversations', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.conversations (
          id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END;
    `);

    await pool.request().query(`
      IF OBJECT_ID('dbo.messages', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.messages (
          id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
          conversation_id UNIQUEIDENTIFIER NOT NULL,
          role NVARCHAR(20) NOT NULL,
          content NVARCHAR(MAX) NOT NULL,
          sequence INT NOT NULL DEFAULT 1,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          CONSTRAINT FK_messages_conversations
            FOREIGN KEY (conversation_id) REFERENCES dbo.conversations(id)
        );
        CREATE INDEX IX_messages_conversation_created
          ON dbo.messages (conversation_id, created_at);
      END;
    `);

    // Incremental migrations — safe to re-run (idempotent)
    await pool.request().query(`
      IF COL_LENGTH('dbo.conversations', 'title') IS NULL
        ALTER TABLE dbo.conversations ADD title NVARCHAR(255) NULL;
    `);

    await pool.request().query(`
      IF COL_LENGTH('dbo.messages', 'payload') IS NULL
        ALTER TABLE dbo.messages ADD payload NVARCHAR(MAX) NULL;
    `);

    // Inspect actual schema to set capability flags — guards all INSERT/SELECT queries
    const schemaResult = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN ('conversations', 'messages');
    `);

    const hasColumn = (tableName: string, columnName: string): boolean =>
      schemaResult.recordset.some(
        (row) => String(row.TABLE_NAME) === tableName && String(row.COLUMN_NAME) === columnName
      );

    this.conversationHasTitle = hasColumn("conversations", "title");
    this.messageHasPayload = hasColumn("messages", "payload");
    this.messageHasSequence = hasColumn("messages", "sequence");

    // Only set initialized if ALL expected columns are present
    // If any migration failed silently, we'll retry next request
    if (this.messageHasPayload && this.conversationHasTitle) {
      this.initialized = true;
    }

    console.log(
      `[chatPersistence] Schema OK — title:${this.conversationHasTitle} payload:${this.messageHasPayload} sequence:${this.messageHasSequence}`
    );
  }

  private async getReadyPool(): Promise<ConnectionPool> {
    const pool = await getSqlPool();
    await this.ensureTables(pool);
    return pool;
  }

  async listConversations(limit = 50): Promise<StoredConversation[]> {
    const pool = await this.getReadyPool();
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const result = await pool
      .request()
      .input("limit", safeLimit)
      .query(
        `
        SELECT TOP (@limit)
          id,
          ${this.conversationHasTitle ? "title" : "CAST(NULL AS NVARCHAR(255)) AS title"},
          created_at,
          updated_at
        FROM dbo.conversations
        ORDER BY updated_at DESC;
      `
      );

    return result.recordset.map((row) => ({
      id: String(row.id),
      title: row.title ? String(row.title) : null,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
    }));
  }

  async createConversation(title?: string): Promise<StoredConversation> {
    const pool = await this.getReadyPool();
    const id = randomUUID();
    const finalTitle = title?.trim() || null;

    const req = pool.request().input("id", id);
    if (this.conversationHasTitle) {
      req.input("title", finalTitle);
    }
    await req.query(
      `
        INSERT INTO dbo.conversations (id, ${this.conversationHasTitle ? "title," : ""} updated_at)
        VALUES (@id, ${this.conversationHasTitle ? "@title," : ""} SYSUTCDATETIME());
      `
    );

    const rows = await this.listConversations(1);
    const created = rows.find((item) => item.id === id);
    if (created) {
      return created;
    }

    return {
      id,
      title: finalTitle,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  async getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
    const pool = await this.getReadyPool();
    const result = await pool
      .request()
      .input("conversationId", conversationId)
      .query(
        `
        SELECT
          id,
          conversation_id,
          role,
          content,
          ${this.messageHasPayload ? "payload" : "CAST(NULL AS NVARCHAR(MAX)) AS payload"},
          created_at
        FROM dbo.messages
        WHERE conversation_id = @conversationId
        ORDER BY ${this.messageHasSequence ? "sequence ASC, " : ""}created_at ASC;
      `
      );

    return result.recordset.map((row) => ({
      id: String(row.id),
      conversation_id: String(row.conversation_id),
      role: String(row.role) === "assistant" ? "assistant" : "user",
      content: String(row.content ?? ""),
      payload: row.payload ? String(row.payload) : null,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    }));
  }

  async addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    payload?: unknown
  ): Promise<StoredMessage> {
    const pool = await this.getReadyPool();
    const id = randomUUID();
    const payloadJson = payload === undefined ? null : JSON.stringify(payload);
    let nextSequence = 1;

    if (this.messageHasSequence) {
      const seqResult = await pool
        .request()
        .input("conversationId", conversationId)
        .query(`
          SELECT ISNULL(MAX(sequence), 0) + 1 AS next_sequence
          FROM dbo.messages
          WHERE conversation_id = @conversationId;
        `);
      nextSequence = Number(seqResult.recordset?.[0]?.next_sequence ?? 1);
    }

    const request = pool
      .request()
      .input("id", id)
      .input("conversationId", conversationId)
      .input("role", role)
      .input("content", content);
    if (this.messageHasPayload) {
      request.input("payload", payloadJson);
    }
    if (this.messageHasSequence) {
      request.input("sequence", nextSequence);
    }

    await request.query(
      `
        INSERT INTO dbo.messages (
          id,
          conversation_id,
          role,
          content,
          ${this.messageHasSequence ? "sequence," : ""}
          ${this.messageHasPayload ? "payload," : ""}
          created_at
        )
        VALUES (
          @id,
          @conversationId,
          @role,
          @content,
          ${this.messageHasSequence ? "@sequence," : ""}
          ${this.messageHasPayload ? "@payload," : ""}
          SYSUTCDATETIME()
        );

        UPDATE dbo.conversations
        SET updated_at = SYSUTCDATETIME()
        WHERE id = @conversationId;
      `
    );

    return {
      id,
      conversation_id: conversationId,
      role,
      content,
      payload: payloadJson,
      created_at: new Date().toISOString()
    };
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    const pool = await this.getReadyPool();
    const result = await pool
      .request()
      .input("conversationId", conversationId)
      .query(`
        DELETE FROM dbo.messages WHERE conversation_id = @conversationId;
        DELETE FROM dbo.conversations WHERE id = @conversationId;
        SELECT @@ROWCOUNT AS affected;
      `);

    return Number(result.recordset?.[0]?.affected ?? 0) > 0;
  }
}

export const chatPersistenceService = new ChatPersistenceService();
