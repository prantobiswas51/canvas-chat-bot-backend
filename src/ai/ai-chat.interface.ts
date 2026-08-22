import { GeminiHistoryTurn, GeminiTool } from './gemini.service';

// Shared contract GeminiService/OpenAiService both implement — lets
// AiReplyService (src/ai/ai-reply.service.ts) stay provider-agnostic and
// pick whichever one AiSettings.aiProvider points at, per message.
//
// Resolves to `undefined` for a final, non-retryable outcome (missing API
// key, empty/safety-blocked response, non-transient 4xx). Throws
// RetryableAiError (see retryable-ai-error.ts) for transient failures —
// 429 rate/spend limits, 5xx provider outages, network errors — which the
// AI-reply queue processor catches to trigger a BullMQ retry with backoff.
export interface AiChatService {
  generateReply(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools?: GeminiTool[],
  ): Promise<string | undefined>;
}
