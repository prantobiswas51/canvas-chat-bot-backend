import { IsEnum } from 'class-validator';
import { ConversationStatus } from '../entities/conversation.entity';

export class UpdateStatusDto {
  @IsEnum(ConversationStatus)
  status: ConversationStatus;
}
