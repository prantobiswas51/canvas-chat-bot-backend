import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// OpenAI/Claude removed while debugging Gemini 429s — only Gemini is wired
// up right now (see AiReplyService/GeminiService). Kept as a union (rather
// than deleting the column) so re-adding a provider later is just a TS
// change again, no migration.
export type AiProviderName = 'gemini';

// Singleton row (id is always 'default') — one shared set of custom
// instructions appended to every AI reply's system prompt, editable from
// the Settings page instead of hardcoding them in webhook.service.ts.
@Entity('ai_settings')
export class AiSettings {
  @PrimaryColumn({ type: 'varchar', length: 20, default: 'default' })
  id: string;

  @Column({ name: 'custom_instructions', type: 'text', nullable: true })
  customInstructions?: string;

  // Whether the AI replies to anything at all right now — a global kill
  // switch checked on every inbound message (see webhook.service.ts).
  @Column({ name: 'ai_enabled_by_default', type: 'boolean', default: true })
  aiEnabledByDefault: boolean;

  // Which chat-completion provider handles replies/tool-calling/vision.
  // Plain varchar (not a pg enum) so adding a provider later is just a
  // TS union change, no schema migration.
  @Column({ name: 'ai_provider', type: 'varchar', length: 20, default: 'gemini' })
  aiProvider: AiProviderName;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
