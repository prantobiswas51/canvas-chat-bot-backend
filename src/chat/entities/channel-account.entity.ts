import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

export enum ChannelType {
  WHATSAPP = 'whatsapp',
  MESSENGER = 'messenger',
  INSTAGRAM = 'instagram',
}

// One row per connected FB Page / WhatsApp number / IG account.
@Entity('channel_accounts')
export class ChannelAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: ChannelType })
  channel: ChannelType;

  // Page ID / phone_number_id / IG-scoped account ID from the provider.
  @Column({ name: 'external_account_id', type: 'varchar', length: 255 })
  externalAccountId: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255 })
  displayName: string;

  @Exclude()
  @Column({ name: 'access_token', type: 'varchar', length: 1000, nullable: true, select: false })
  accessToken?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
