import { IsObject, IsOptional, IsString } from 'class-validator';

class MessageAttachmentDto {
  name: string;
  url: string;
  type: 'image' | 'file';
  size?: string;
}

export class SendMessageDto {
  // Optional now — an image-only send (no caption typed) is a valid message,
  // same as a customer sending just a photo. ChatService fills in a
  // placeholder for storage/display when both this and attachment.type
  // combine into "no text at all".
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsObject()
  attachment?: MessageAttachmentDto;
}
