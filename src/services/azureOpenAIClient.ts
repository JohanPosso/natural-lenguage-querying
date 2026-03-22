import "@azure/openai/types";
import { AzureOpenAI } from "openai";
import { env } from "../config/env";

class AzureOpenAIService {
  private readonly client: AzureOpenAI;
  private readonly chatDeployment: string;
  private readonly embeddingDeployment: string;

  constructor() {
    if (!env.azureEndpoint || !env.azureApiKey) {
      throw new Error(
        "Missing Azure OpenAI configuration: AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY."
      );
    }
    if (!env.azureChatDeployment || !env.azureEmbeddingDeployment) {
      throw new Error(
        "Missing Azure deployment names: AZURE_OPENAI_CHAT_DEPLOYMENT / AZURE_OPENAI_EMBEDDING_DEPLOYMENT."
      );
    }

    this.chatDeployment = env.azureChatDeployment;
    this.embeddingDeployment = env.azureEmbeddingDeployment;
    this.client = new AzureOpenAI({
      endpoint: env.azureEndpoint,
      apiKey: env.azureApiKey,
      apiVersion: "2024-10-21"
    });
  }

  async embedText(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.embeddingDeployment,
      input: text
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding?.length) {
      throw new Error("Embedding generation failed: empty vector.");
    }

    return embedding;
  }

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    temperature = 0
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.chatDeployment,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Chat completion failed: empty content.");
    }

    return content;
  }
}

export const azureOpenAIService = new AzureOpenAIService();
