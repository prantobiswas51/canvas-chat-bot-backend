import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Customer } from './customer.entity';
import { ChannelAccount } from './channel-account.entity';

// Maps a customer to their platform-specific ID (Messenger PSID, WhatsApp wa_id, IG-scoped ID).
// Needed because the same customer can reach out on multiple channels, and PSIDs
// aren't stable across pages — this is what lets an inbound webhook event resolve
// to the right existing customer instead of creating a duplicate.
@Entity('customer_channel_identities')
@Index(['channelAccountId', 'externalUserId'], { unique: true })
export class CustomerChannelIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => ChannelAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_account_id' })
  channelAccount: ChannelAccount;

  @Column({ name: 'channel_account_id', type: 'uuid' })
  channelAccountId: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 255 })
  externalUserId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
