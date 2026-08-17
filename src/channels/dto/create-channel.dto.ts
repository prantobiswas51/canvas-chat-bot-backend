import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ChannelType } from '../../chat/entities/channel-account.entity';

export class CreateChannelDto {
  @IsEnum(ChannelType)
  channel: ChannelType;

  // Page ID (Messenger) / phone_number_id (WhatsApp) / IG Business Account ID (Instagram).
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalAccountId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  displayName: string;

  @IsOptional()
  @IsString()
  accessToken?: string;
}
