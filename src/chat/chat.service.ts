import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { Message, MessageSender } from './entities/message.entity';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ChatGateway } from '../realtime/chat.gateway';
import { DispatchService } from '../dispatch/dispatch.service';
import { toConversationDto, toMessageDto } from './chat.mappers';

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly chatGateway: ChatGateway,
    private readonly dispatchService: DispatchService,
  ) {}

  async listConversations() {
    const conversations = await this.conversationRepo.find({
      relations: { customer: true },
      order: { lastMessageAt: 'DESC' },
    });

    return conversations.map((c) => toConversationDto(c));
  }

  async getMessages(conversationId: string) {
    await this.assertConversationExists(conversationId);

    const messages = await this.messageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });

    return messages.map((m) => toMessageDto(m));
  }

  async sendAgentMessage(conversationId: string, dto: SendMessageDto) {
    const conversation = await this.assertConversationExists(conversationId);

    const message = this.messageRepo.create({
      conversationId,
      senderType: MessageSender.HUMAN_AGENT,
      senderName: 'Agent',
      content: dto.content,
      attachment: dto.attachment,
    });
    const saved = await this.messageRepo.save(message);

    conversation.lastMessage = dto.attachment ? `📎 ${dto.attachment.name}` : dto.content;
    conversation.lastMessageAt = saved.createdAt;
    conversation.unreadCount = 0;
    const savedConversation = await this.conversationRepo.save(conversation);

    const messageDto = toMessageDto(saved);
    this.chatGateway.emitNewMessage(messageDto);

    // Agent-sent messages don't need a customer relation load for the list
    // patch — the frontend only needs the fields that changed.
    const conversationWithCustomer = await this.conversationRepo.findOne({
      where: { id: savedConversation.id },
      relations: { customer: true },
    });
    if (conversationWithCustomer) {
      this.chatGateway.emitConversationUpdated(toConversationDto(conversationWithCustomer));
    }

    if (dto.content) {
      await this.dispatchService.sendReply(conversation, dto.content);
    }

    return messageDto;
  }

  async updateStatus(conversationId: string, dto: UpdateStatusDto) {
    const conversation = await this.assertConversationExists(conversationId);
    conversation.status = dto.status;
    const saved = await this.conversationRepo.save(conversation);

    const conversationWithCustomer = await this.conversationRepo.findOne({
      where: { id: saved.id },
      relations: { customer: true },
    });
    if (conversationWithCustomer) {
      this.chatGateway.emitConversationUpdated(toConversationDto(conversationWithCustomer));
    }

    return { id: saved.id, status: saved.status };
  }

  async assignModerator(conversationId: string, moderatorId: string) {
    const conversation = await this.assertConversationExists(conversationId);
    conversation.assignedModeratorId = moderatorId;
    const saved = await this.conversationRepo.save(conversation);

    const conversationWithCustomer = await this.conversationRepo.findOne({
      where: { id: saved.id },
      relations: { customer: true },
    });
    if (conversationWithCustomer) {
      this.chatGateway.emitConversationUpdated(toConversationDto(conversationWithCustomer));
    }

    return { id: saved.id, assignedModeratorId: saved.assignedModeratorId };
  }

  private async assertConversationExists(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}
