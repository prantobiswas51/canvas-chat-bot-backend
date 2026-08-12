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

  // AI is off by default — a conversation only goes to ai_active once an agent
  // explicitly enables it after opening the chat.
  @Column({ type: 'enum', enum: ConversationStatus, default: ConversationStatus.HUMAN_MODERATOR })
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
