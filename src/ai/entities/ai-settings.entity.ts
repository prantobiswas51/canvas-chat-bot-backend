import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Which chat-completion provider handles replies — picked per message from
// this column (see AiReplyService.resolveAiProvider), so the Settings page
// dropdown takes effect immediately, no restart needed. Claude was tried
// earlier and removed; re-add it here the same way if it comes back.
export type AiProviderName = 'gemini' | 'openai';

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
