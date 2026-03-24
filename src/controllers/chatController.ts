import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { chatPersistenceService } from "../services/chatPersistenceService";
import { runAskPipeline, type ConversationTurn, type AskResponsePayload } from "./askController";
import { debugLogger } from "../services/debugLogger";

function titleFromQuestion(question: string): string {
  const normalized = question.trim().replace(/\s+/g, " ");
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

export async function listConversationsController(req: Request, res: Response): Promise<Response> {
  try {
    const userId = req.userId ?? "anonymous";
    const conversations = await chatPersistenceService.listConversations(userId);
    await debugLogger.log("chat", "list_conversations", { userId, count: conversations.length });
    return res.status(200).json({ conversations });
  } catch (error) {
    await debugLogger.log("chat", "list_conversations_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "CHAT_LIST_ERROR",
      error: (error as Error).message
    });
  }
}

export async function createConversationController(req: Request, res: Response): Promise<Response> {
  try {
    const userId = req.userId ?? "anonymous";
    const title = String(req.body?.title ?? "").trim();
    const conversation = await chatPersistenceService.createConversation(title || undefined, userId);
    await debugLogger.log("chat", "create_conversation", {
      userId,
      conversation_id: conversation.id,
      title: conversation.title
    });
    return res.status(201).json({ conversation });
  } catch (error) {
    await debugLogger.log("chat", "create_conversation_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "CHAT_CREATE_ERROR",
      error: (error as Error).message
    });
  }
}

export async function listMessagesController(req: Request, res: Response): Promise<Response> {
  try {
    const conversationId = String(req.params.id ?? "").trim();
    if (!conversationId) {
      return res.status(400).json({ error: "Conversation id is required." });
    }
    const userId = req.userId ?? "anonymous";
    const messages = await chatPersistenceService.getConversationMessages(conversationId, userId);
    await debugLogger.log("chat", "list_messages", {
      userId,
      conversation_id: conversationId,
      count: messages.length
    });
    return res.status(200).json({ messages });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    await debugLogger.log("chat", "list_messages_error", { error: (error as Error).message });
    return res.status(statusCode).json({
      code: statusCode === 404 ? "CHAT_NOT_FOUND" : "CHAT_MESSAGES_ERROR",
      error: (error as Error).message
    });
  }
}

export async function deleteConversationController(req: Request, res: Response): Promise<Response> {
  try {
    const conversationId = String(req.params.id ?? "").trim();
    if (!conversationId) {
      return res.status(400).json({ error: "Conversation id is required." });
    }

    const userId = req.userId ?? "anonymous";
    const removed = await chatPersistenceService.deleteConversation(conversationId, userId);
    if (!removed) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    await debugLogger.log("chat", "delete_conversation", { userId, conversation_id: conversationId });
    return res.status(200).json({ ok: true, id: conversationId });
  } catch (error) {
    await debugLogger.log("chat", "delete_conversation_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "CHAT_DELETE_CONVERSATION_ERROR",
      error: (error as Error).message
    });
  }
}

export async function askInConversationController(req: Request, res: Response): Promise<Response> {
  try {
    const traceId = randomUUID();
    const userId = req.userId ?? "anonymous";
    const question = String(req.body?.question ?? req.body?.user_prompt ?? "").trim();
    if (!question) {
      return res.status(400).json({ error: "Field question (or user_prompt) is required." });
    }

    let conversationId = String(req.body?.conversation_id ?? "").trim();
    if (!conversationId) {
      // Crear conversación nueva vinculada al usuario
      const created = await chatPersistenceService.createConversation(titleFromQuestion(question), userId);
      conversationId = created.id;
    } else {
      // Verificar que la conversación existente pertenece al usuario
      try {
        await chatPersistenceService.getConversationMessages(conversationId, userId);
      } catch {
        return res.status(404).json({
          code: "CHAT_NOT_FOUND",
          error: "Conversation not found or does not belong to this user."
        });
      }
    }

    await debugLogger.log("chat", "conversation_question_received", {
      traceId,
      userId,
      conversation_id: conversationId,
      question
    });

    await chatPersistenceService.addMessage(conversationId, "user", question);

    // Historial de conversación (excluye el mensaje que acabamos de guardar)
    const allMessages = await chatPersistenceService.getConversationMessages(conversationId);
    const historyMessages = allMessages.slice(0, -1);
    const conversationHistory: ConversationTurn[] = historyMessages
      .slice(-8) // últimos 4 intercambios (8 mensajes)
      .map((m) => {
        const turn: ConversationTurn = { role: m.role, content: m.content };
        if (m.payload) {
          try {
            const p = JSON.parse(m.payload) as AskResponsePayload;
            turn.cube = p.data?.cube ?? null;
            turn.measure = p.data?.measure ?? null;
          } catch {
            // ignorar errores de parse
          }
        }
        return turn;
      });

    const payload = await runAskPipeline(question, {
      traceId,
      conversationHistory,
      allowedCubes: req.allowedCubes ?? null
    });
    await chatPersistenceService.addMessage(conversationId, "assistant", payload.answer, payload);
    await debugLogger.log("chat", "conversation_answer_sent", {
      traceId,
      userId,
      conversation_id: conversationId,
      answer: payload.answer
    });

    return res.status(200).json({
      conversation_id: conversationId,
      ...payload
    });
  } catch (error) {
    await debugLogger.log("chat", "conversation_ask_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "CHAT_ASK_ERROR",
      error: (error as Error).message
    });
  }
}
