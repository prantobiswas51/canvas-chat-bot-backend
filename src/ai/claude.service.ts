import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiHistoryTurn, GeminiTool, GeminiToolParameterSchema } from './gemini.service';

interface ClaudeContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

interface ClaudeResponse {
  content?: ClaudeContentBlock[];
  stop_reason?: string;
  error?: { message: string };
}

const MAX_TOOL_ROUNDS = 3;

// Same upper-case-to-lower-case JSON Schema conversion OpenAiService needs —
// Claude's tool `input_schema` uses standard (lower-case) JSON Schema too.
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

function turnToContent(turn: GeminiHistoryTurn): string | ClaudeContentBlock[] {
  if (!turn.image) return turn.text || '';

  const imageBlock: ClaudeContentBlock = turn.image.data
    ? { type: 'image', source: { type: 'base64', media_type: turn.image.mimeType, data: turn.image.data } }
    : turn.image.fileUri
      ? { type: 'image', source: { type: 'url', url: turn.image.fileUri } }
      : { type: 'text', text: turn.text || '' };

  return [imageBlock, { type: 'text', text: turn.text || '(sent an image)' }];
}

// Claude equivalent of GeminiService/OpenAiService — same
// generateReply(systemPrompt, history, tools) contract, via Anthropic's
// Messages API (tool_use blocks for function-calling, image content blocks
// for vision — base64 inline for WhatsApp, source.type: 'url' for
// Messenger's CDN links, no download needed either way).
@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  constructor(private readonly configService: ConfigService) {}

  async generateReply(
    systemPrompt: string,
    history: GeminiHistoryTurn[],
    tools: GeminiTool[] = [],
  ): Promise<string | undefined> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    const model = this.configService.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-4-5');

    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not configured — skipping AI reply');
      return undefined;
    }

    if (history.length === 0) return undefined;

    let messages: ClaudeMessage[] = history.map((turn) => ({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: turnToContent(turn),
    }));

    const toolsPayload = tools.length
      ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.parameters) }))
      : undefined;

    const url = 'https://api.anthropic.com/v1/messages';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let data: ClaudeResponse;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            system: systemPrompt,
            messages,
            ...(toolsPayload ? { tools: toolsPayload } : {}),
            temperature: 0.4,
            max_tokens: 512,
          }),
        });

        data = (await res.json()) as ClaudeResponse;

        if (!res.ok) {
          this.logger.error(`Claude messages request failed (${res.status}): ${JSON.stringify(data)}`);
          return undefined;
        }
      } catch (err) {
        this.logger.error(`Claude request failed: ${(err as Error).message}`);
        return undefined;
      }

      const content = data.content ?? [];
      const toolUseBlocks = content.filter((c) => c.type === 'tool_use');

      if (data.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
        const text = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
          .trim();
        return text || undefined;
      }

      if (round === MAX_TOOL_ROUNDS) {
        this.logger.warn('Claude exceeded max tool-call rounds — dropping the reply for this turn');
        return undefined;
      }

      // Echo the assistant's tool_use turn back verbatim, then answer with a
      // user turn carrying one tool_result block per tool_use block — Claude
      // can request several tools in a single turn.
      messages = [...messages, { role: 'assistant', content }];

      const resultBlocks: ClaudeContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const tool = tools.find((t) => t.name === block.name);
        const args = block.input ?? {};

        let result: unknown;
        if (tool) {
          this.logger.log(`Claude tool call: ${block.name}(${JSON.stringify(args)})`);
          try {
            result = await tool.execute(args);
          } catch (err) {
            result = { error: (err as Error).message };
          }
        } else {
          this.logger.warn(`Claude requested unknown tool: ${block.name}`);
          result = { error: `Unknown tool: ${block.name}` };
        }

        resultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }

      messages.push({ role: 'user', content: resultBlocks });
    }

    return undefined;
  }
}
