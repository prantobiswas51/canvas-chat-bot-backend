import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

class MessageAttachmentDto {
  name: string;
  url: string;
  type: 'image' | 'file';
  size?: string;
}

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  content: string;

  @IsOptional()
  @IsObject()
  attachment?: MessageAttachmentDto;
}
