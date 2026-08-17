import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Customer } from './customer.entity';
import { ChannelAccount, ChannelType } from './channel-account.entity';

export enum ConversationStatus {
  AI_ACTIVE = 'ai_active',
  HUMAN_MODERATOR = 'human_moderator',
  RESOLVED = 'resolved',
}

// Captured once, off the first message of the conversation, when the
// customer arrived by tapping a Click-to-WhatsApp / Click-to-Messenger ad
// (see WebhookService's referral parsing). Absent for anyone who just
// messaged the number/Page directly.
export interface AdReferral {
  platform: 'whatsapp' | 'messenger';
  source?: string; // e.g. 'ad' (WhatsApp) or 'ADS' (Messenger)
  adId?: string;
  headline?: string;
  body?: string;
  mediaUrl?: string;
  ctwaClid?: string;
}

// One thread per customer per channel.
@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => ChannelAccount, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'channel_account_id' })
  channelAccount?: ChannelAccount;

  @Column({ name: 'channel_account_id', type: 'uuid', nullable: true })
  channelAccountId?: string;

  // Denormalized for cheap filtering/badges without a join.
  @Column({ type: 'enum', enum: ChannelType })
  channel: ChannelType;

  // AI is on by default for new conversations — an agent can take over via
  // "Take Over (Human Mode)" in the chat window.
  @Column({ type: 'enum', enum: ConversationStatus, default: ConversationStatus.AI_ACTIVE })
  status: ConversationStatus;

  // Plain FK (no relation object) to avoid a cross-module import cycle with UsersModule.
  @Column({ name: 'assigned_moderator_id', type: 'uuid', nullable: true })
  assignedModeratorId?: string;

  @Column({ name: 'last_message', type: 'text', nullable: true })
  lastMessage?: string;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt?: Date;

  @Column({ name: 'unread_count', type: 'int', default: 0 })
  unreadCount: number;

  // Set once, off whichever message first arrives with ad-referral data
  // (see WebhookService) — null for conversations that started organically.
  @Column({ name: 'ad_referral', type: 'jsonb', nullable: true })
  adReferral?: AdReferral;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
