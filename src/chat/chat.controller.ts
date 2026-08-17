import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AssignModeratorDto } from './dto/assign-moderator.dto';

@Controller('conversations')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  list() {
    return this.chatService.listConversations();
  }

  @Get(':id/messages')
  getMessages(@Param('id', ParseUUIDPipe) id: string) {
    return this.chatService.getMessages(id);
  }

  @Post(':id/messages')
  sendMessage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.chatService.sendAgentMessage(id, dto);
  }

  @Patch(':id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStatusDto) {
    return this.chatService.updateStatus(id, dto);
  }

  @Patch(':id/assign')
  assignModerator(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignModeratorDto) {
    return this.chatService.assignModerator(id, dto.moderatorId);
  }
}
