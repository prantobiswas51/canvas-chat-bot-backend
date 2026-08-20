// Thrown by GeminiService/OpenAiService/ClaudeService for failures that are
// worth retrying — 429 (rate/spend limit) and 5xx (provider-side outage) HTTP
// responses, plus network-level errors (timeouts, DNS, connection reset).
// The AI-reply queue processor (src/queue/ai-reply.processor.ts) catches
// this specifically and lets BullMQ's attempts/backoff handle the retry —
// any other error, or a plain `undefined` return (empty/safety-blocked
// response, missing API key), is treated as final and never retried.
export class RetryableAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableAiError';
  }
}
