import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiHistoryTurn, GeminiTool, GeminiToolParameterSchema } from './gemini.service';
import { RetryableAiError } from './retryable-ai-error';

interface OpenAiContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: OpenAiMessage;
    finish_reason?: string;
  }>;
  error?: { message: string };
}

const MAX_TOOL_ROUNDS = 3;

// Tried in order after OPENAI_MODEL, whenever a call fails with a
// *retryable* error (429 rate/spend limit or 5xx) — same reasoning as
// Gemini's fallback chain (see gemini.service.ts): one model being
// overloaded/rate-limited doesn't mean every model is, so hopping to a
// sibling model within the same job attempt recovers a reply immediately
// instead of failing the whole job and waiting on BullMQ's backoff.
// Overridable via OPENAI_FALLBACK_MODELS (comma-separated).
const DEFAULT_FALLBACK_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'];

// Converts the shared tool-schema shape's upper-case type names ("OBJECT",
// "STRING", ...) — a Gemini-ism the rest of the app's tool definitions are
// written in — into the lower-case JSON Schema OpenAI's function-calling
// API actually expects, recursively through nested properties/items.
function toJsonSchema(schema: GeminiToolParameterSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { type: schema.type.toLowerCase() };
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    );
  }
  if (schema.items) result.items = toJsonSchema(schema.items);
  return result;
}

// GeminiHistoryImage is always inline base64 now (see gemini.service.ts —
// the fileUri path was removed after it turned out unreliable for
// Messenger's CDN links), so this is a straight data: URI build, no
// fallback branch needed.
function turnToContent(turn: GeminiHistoryTurn): string | OpenAiContentPart[] {
  if (!turn.image?.data) return turn.text || '';

  return [
    { type: 'image_url', image_url: { url: `data:${turn.image.mimeType};base64,${turn.image.data}` } },
    { type: 'text', text: turn.text || '(sent an image)' },
  ];
}

// GPT equivalent of GeminiService — implements the same
// generateReply(systemPrompt, history, tools) contract (see
// ai-chat.interface.ts) so AiReplyService can call either one
// interchangeably based on AiSettings.aiProvider (Settings → AI
// Instructions → provider dropdown), picked fresh per message.
@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);

  // Same pattern as GeminiService.totalApiCalls — lets you compare actual
  // request counts against OpenAI's usage dashboard while testing GPT.
  private static totalApiCalls = 0;
  private static nextCallNumber(): number {
    OpenAiService.totalApiCalls += 1;
    return OpenAiService.totalApiCalls;
  }

  constructor(private readonly configService: ConfigService) {}

  private modelChain(): string[] {
    const primary = this.configService.get<string>('OPENAI_MODEL', 'gpt-4o-mini');
    const fallbacksRaw = this.configService.get<string>('OPENAI_FALLBACK_MODELS');
    const fallbacks = fallbacksRaw
      ? fallbacksRaw.split(',').map((m) => m.trim()).filter(Boolean)
      : DEFAULT_FALLBACK_MODELS;
    return [primary, ...fallbacks.filter((m) => m !== primary)];
  }

  async generateReply(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools: GeminiTool[] = [],
  ): Promise<string | undefined> {
    // CHATGPT_API_KEY is the name already used in this project's .env;
    // OPENAI_API_KEY works too if you'd rather name it that.
    const apiKey =
      this.configService.get<string>('CHATGPT_API_KEY') || this.configService.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      this.logger.warn('CHATGPT_API_KEY/OPENAI_API_KEY not configured — skipping AI reply');
      return undefined;
    }

    if (history.length === 0) return undefined;

    const chain = this.modelChain();
    let lastError: unknown;

    for (const model of chain) {
      try {
        return await this.generateReplyWithModel(systemPrompt, history, tools, apiKey, model);
      } catch (err) {
        if (!(err instanceof RetryableAiError)) throw err;
        lastError = err;
        const isLast = model === chain[chain.length - 1];
        if (!isLast) {
          this.logger.warn(`Model "${model}" hit a transient error — falling back to next model in chain`);
        }
      }
    }

    // Every model in the chain failed transiently — this is now a real
    // outage worth letting the BullMQ job retry (with backoff) for, not
    // something another model swap can fix.
    this.logger.error(`All ${chain.length} model(s) in fallback chain failed transiently — giving up for this attempt`);
    throw lastError instanceof RetryableAiError ? lastError : new RetryableAiError('All OpenAI models failed');
  }

  private async generateReplyWithModel(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools: GeminiTool[],
    apiKey: string,
    model: string,
  ): Promise<string | undefined> {
    let messages: OpenAiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((turn) => ({
        role: (turn.role === 'model' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: turnToContent(turn),
      })),
    ];

    const toolsPayload = tools.length
      ? tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) },
        }))
      : undefined;

    const url = 'https://api.openai.com/v1/chat/completions';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let data: OpenAiChatCompletionResponse;
      try {
        const callNumber = OpenAiService.nextCallNumber();
        this.logger.log(`OpenAI API call #${callNumber} (chat.completions, round=${round}, model=${model})`);

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            ...(toolsPayload ? { tools: toolsPayload } : {}),
            temperature: 0.4,
            max_tokens: 512,
          }),
        });

        data = (await res.json()) as OpenAiChatCompletionResponse;

        if (!res.ok) {
          const msg = `OpenAI chat completion failed (${res.status}): ${JSON.stringify(data)}`;
          this.logger.error(msg);
          // 429/5xx are transient — let the queue processor retry with
          // backoff instead of dropping the reply (same policy as Gemini).
          if (res.status === 429 || res.status >= 500) throw new RetryableAiError(msg);
          return undefined;
        }
      } catch (err) {
        if (err instanceof RetryableAiError) throw err;
        this.logger.error(`OpenAI request failed: ${(err as Error).message}`);
        throw new RetryableAiError((err as Error).message);
      }

      const message = data.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        const text = typeof message?.content === 'string' ? message.content.trim() : '';
        return text || undefined;
      }

      if (round === MAX_TOOL_ROUNDS) {
        this.logger.warn('OpenAI exceeded max tool-call rounds — dropping the reply for this turn');
        return undefined;
      }

      // Echo the assistant's tool-call turn back verbatim, then answer each
      // requested call with its own tool-role message — OpenAI allows (and
      // often issues) more than one tool call in a single turn.
      messages = [...messages, message as OpenAiMessage];

      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // Malformed arguments — proceed with empty args rather than crash.
        }

        let result: unknown;
        if (tool) {
          this.logger.log(`OpenAI tool call: ${call.function.name}(${JSON.stringify(args)})`);
          try {
            result = await tool.execute(args);
          } catch (err) {
            result = { error: (err as Error).message };
          }
        } else {
          this.logger.warn(`OpenAI requested unknown tool: ${call.function.name}`);
          result = { error: `Unknown tool: ${call.function.name}` };
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    return undefined;
  }
}
