import { GeminiHistoryTurn, GeminiTool } from './gemini.service';

// Shared contract both GeminiService and OpenAiService implement — lets
// webhook.service.ts stay provider-agnostic behind the AI_CHAT_SERVICE
// token (see ai.module.ts / AI_PROVIDER env var).
export interface AiChatService {
  generateReply(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools?: GeminiTool[],
  ): Promise<string | undefined>;
}
