import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageSender {
  CUSTOMER = 'customer',
  AI_BOT = 'ai_bot',
  HUMAN_AGENT = 'human_agent',
  SYSTEM = 'system',
}

export interface MessageAttachment {
  name: string;
  url: string;
  type: 'image' | 'file';
  size?: string;
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @Column({ name: 'sender_type', type: 'enum', enum: MessageSender })
  senderType: MessageSender;

  @Column({ name: 'sender_name', type: 'varchar', length: 255, nullable: true })
  senderName?: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', nullable: true })
  attachment?: MessageAttachment;

  // De-dupes retried webhook deliveries from Meta once inbound ingestion is wired.
  @Index({ unique: true, where: '"external_message_id" IS NOT NULL' })
  @Column({ name: 'external_message_id', type: 'varchar', length: 255, nullable: true })
  externalMessageId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
