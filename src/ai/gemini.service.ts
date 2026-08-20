import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryableAiError } from './retryable-ai-error';

export interface GeminiHistoryImage {
  mimeType: string;
  // Always inline base64 data now, regardless of platform — WhatsApp and
  // Messenger images are both downloaded and base64-encoded before ever
  // reaching this type (see AiReplyService.resolveGeminiImage). There used
  // to be a fileUri alternative that let Gemini fetch the image itself
  // server-side, but that was unreliable for Messenger's CDN links and has
  // been removed — every image is downloaded by this app and sent inline.
  data: string;
}

export interface GeminiHistoryTurn {
  role: 'user' | 'model';
  text: string;
  image?: GeminiHistoryImage;
}

// Gemini's classic (non-Interactions-API) function schema uses upper-case
// type names — "OBJECT", "STRING", etc. — not lowercase JSON-Schema style.
export interface GeminiToolParameterSchema {
  type: 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY';
  description?: string;
  properties?: Record<string, GeminiToolParameterSchema>;
  items?: GeminiToolParameterSchema;
  required?: string[];
  enum?: string[];
}

export interface GeminiTool {
  name: string;
  description: string;
  parameters: GeminiToolParameterSchema;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

function turnToParts(turn: GeminiHistoryTurn): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (turn.image?.data) {
    parts.push({ inlineData: { mimeType: turn.image.mimeType, data: turn.image.data } });
  }
  // Text part last so a caption reads naturally after the image, and so a
  // turn with only an image still gets a placeholder part if text is empty.
  parts.push({ text: turn.text || (turn.image ? '(sent an image)' : '') });
  return parts;
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
}

const MAX_TOOL_ROUNDS = 3;

// Tried in order after the configured primary model, whenever a call fails
// with a *retryable* error (429 rate/spend limit, 5xx, or a 503 "model
// overloaded" — the exact failure that prompted this) — a specific model
// being overloaded doesn't mean every model is, so hopping to a sibling
// model within the same job attempt recovers a reply immediately instead of
// failing the whole job and waiting on BullMQ's backoff. Overridable via
// GEMINI_FALLBACK_MODELS (comma-separated) if you want a different order.
const DEFAULT_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

// Uses the classic generateContent API (confirmed by Google as "fully
// supported" alongside the newer Interactions API) — plain text generation,
// with optional function/tool calling when `tools` is passed in.
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  // Shared across the whole process (this service is a singleton) — total
  // count of actual HTTP requests made to Gemini's API since this process
  // started. Logged on every call so you can compare against Google AI
  // Studio's usage/billing dashboard and see exactly how many requests this
  // app itself is responsible for, independent of whatever Google says.
  private static totalApiCalls = 0;

  private static nextCallNumber(): number {
    GeminiService.totalApiCalls += 1;
    return GeminiService.totalApiCalls;
  }

  constructor(private readonly configService: ConfigService) {}

  private modelChain(): string[] {
    const primary = this.configService.get<string>('GEMINI_MODEL', 'gemini-2.5-flash');
    const fallbacksRaw = this.configService.get<string>('GEMINI_FALLBACK_MODELS');
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
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    if (!apiKey || apiKey === 'your_gemini_api_key') {
      this.logger.warn('GEMINI_API_KEY not configured — skipping AI reply');
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
    throw lastError instanceof RetryableAiError ? lastError : new RetryableAiError('All Gemini models failed');
  }

  private async generateReplyWithModel(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools: GeminiTool[],
    apiKey: string,
    model: string,
  ): Promise<string | undefined> {
    let contents: GeminiContent[] = history.map((turn) => ({ role: turn.role, parts: turnToParts(turn) }));
    const toolsPayload = tools.length
      ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
      : undefined;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let data: GeminiGenerateContentResponse;
      try {
        const callNumber = GeminiService.nextCallNumber();
        this.logger.log(`Gemini API call #${callNumber} (generateContent, round=${round}, model=${model})`);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
            contents,
            ...(toolsPayload ? { tools: toolsPayload } : {}),
            generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          // Google's JSON body is often just {code, message, status} with no
          // detail on *which* quota was hit — Retry-After (and sometimes
          // other rate-limit headers) can carry more, so log those too.
          const retryAfter = res.headers.get('retry-after');
          const msg = `Gemini generateContent failed (${res.status})${retryAfter ? ` retry-after=${retryAfter}s` : ''}: ${errText}`;
          this.logger.error(msg);
          // 429 (rate/spend limit) and 5xx (provider outage) are transient —
          // let the queue processor retry with backoff instead of dropping
          // the reply. Anything else (400 bad request, 401/403 auth) is a
          // real problem that won't fix itself on retry.
          if (res.status === 429 || res.status >= 500) throw new RetryableAiError(msg);
          return undefined;
        }

        data = (await res.json()) as GeminiGenerateContentResponse;
      } catch (err) {
        if (err instanceof RetryableAiError) throw err;
        // Network-level failure (timeout, DNS, connection reset) — also
        // transient, so treat it the same as a 429/5xx.
        this.logger.error(`Gemini request failed: ${(err as Error).message}`);
        throw new RetryableAiError((err as Error).message);
      }

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const functionCallPart = parts.find((p) => p.functionCall);

      if (!functionCallPart?.functionCall) {
        const text = parts
          .map((p) => p.text ?? '')
          .join('')
          .trim();
        return text || undefined;
      }

      if (round === MAX_TOOL_ROUNDS) {
        this.logger.warn('Gemini exceeded max tool-call rounds — dropping the reply for this turn');
        return undefined;
      }

      const { name, args } = functionCallPart.functionCall;
      const tool = tools.find((t) => t.name === name);

      let result: unknown;
      if (tool) {
        this.logger.log(`Gemini tool call: ${name}(${JSON.stringify(args ?? {})})`);
        try {
          result = await tool.execute(args ?? {});
        } catch (err) {
          result = { error: (err as Error).message };
        }
      } else {
        this.logger.warn(`Gemini requested unknown tool: ${name}`);
        result = { error: `Unknown tool: ${name}` };
      }

      contents = [
        ...contents,
        candidate!.content!, // the model's own function-call turn, echoed back verbatim
        { role: 'user', parts: [{ functionResponse: { name, response: { result } } }] },
      ];
    }

    return undefined;
  }

  // Gemini natively understands audio (no separate Whisper-style endpoint
  // needed) — send the clip as inlineData alongside a plain-text instruction
  // and read the transcript back out of the same generateContent response
  // shape used for chat replies.
  async transcribeAudio(buffer: Buffer, mimeType: string): Promise<string | undefined> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    const model = this.configService.get<string>('GEMINI_MODEL', 'gemini-2.5-flash');

    if (!apiKey || apiKey === 'your_gemini_api_key') {
      this.logger.warn('GEMINI_API_KEY not configured — skipping Gemini audio transcription');
      return undefined;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const callNumber = GeminiService.nextCallNumber();
      this.logger.log(`Gemini API call #${callNumber} (transcribeAudio, model=${model})`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType, data: buffer.toString('base64') } },
                {
                  text:
                    'Transcribe this audio message verbatim, in the language it was spoken (do not translate). ' +
                    'Output only the transcript text — no commentary, quotes, or labels. If the audio is silent ' +
                    'or unintelligible, output exactly: [inaudible]',
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 512 },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`Gemini audio transcription failed (${res.status}): ${errText}`);
        return undefined;
      }

      const data = (await res.json()) as GeminiGenerateContentResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();

      if (!text || text === '[inaudible]') return undefined;
      return text;
    } catch (err) {
      this.logger.error(`Gemini audio transcription request failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}
