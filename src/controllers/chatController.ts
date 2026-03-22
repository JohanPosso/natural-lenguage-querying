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

export async function listConversationsController(_req: Request, res: Response): Promise<Response> {
  try {
    const conversations = await chatPersistenceService.listConversations();
    await debugLogger.log("chat", "list_conversations", { count: conversations.length });
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
    const title = String(req.body?.title ?? "").trim();
    const conversation = await chatPersistenceService.createConversation(title || undefined);
    await debugLogger.log("chat", "create_conversation", {
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
    const messages = await chatPersistenceService.getConversationMessages(conversationId);
    await debugLogger.log("chat", "list_messages", {
      conversation_id: conversationId,
      count: messages.length
    });
    return res.status(200).json({ messages });
  } catch (error) {
    await debugLogger.log("chat", "list_messages_error", { error: (error as Error).message });
    return res.status(500).json({
      code: "CHAT_MESSAGES_ERROR",
      error: (error as Error).message
    });
  }
}

export async function askInConversationController(req: Request, res: Response): Promise<Response> {
  try {
    const traceId = randomUUID();
    const question = String(req.body?.question ?? req.body?.user_prompt ?? "").trim();
    if (!question) {
      return res.status(400).json({ error: "Field question (or user_prompt) is required." });
    }

    let conversationId = String(req.body?.conversation_id ?? "").trim();
    if (!conversationId) {
      const created = await chatPersistenceService.createConversation(titleFromQuestion(question));
      conversationId = created.id;
    }
    await debugLogger.log("chat", "conversation_question_received", {
      traceId,
      conversation_id: conversationId,
      question
    });

    await chatPersistenceService.addMessage(conversationId, "user", question);

    // Retrieve conversation history (excluding the just-saved user message = last entry)
    const allMessages = await chatPersistenceService.getConversationMessages(conversationId);
    const historyMessages = allMessages.slice(0, -1); // all except the current user msg
    const conversationHistory: ConversationTurn[] = historyMessages
      .slice(-8) // last 4 exchanges (8 messages)
      .map((m) => {
        const turn: ConversationTurn = { role: m.role, content: m.content };
        if (m.payload) {
          try {
            const p = JSON.parse(m.payload) as AskResponsePayload;
            turn.cube = p.data?.cube ?? null;
            turn.measure = p.data?.measure ?? null;
          } catch {
            // ignore parse errors
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
