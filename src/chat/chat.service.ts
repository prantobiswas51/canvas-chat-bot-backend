import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation, ConversationStatus } from './entities/conversation.entity';
import { Message, MessageSender } from './entities/message.entity';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ChatGateway } from '../realtime/chat.gateway';
import { DispatchService } from '../dispatch/dispatch.service';
import { toConversationDto, toMessageDto } from './chat.mappers';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

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

  async assignModerator(conversationId: string, moderatorId: string | null | undefined) {
    const conversation = await this.assertConversationExists(conversationId);
    conversation.assignedModeratorId = moderatorId ?? null;

    // No moderator = handing the conversation back to the AI. Also reset
    // status to AI_ACTIVE in case it was left in HUMAN_MODERATOR mode (e.g.
    // via "Take Over") — otherwise clearing the assignment alone wouldn't be
    // enough to make the AI actually start replying again (saveInboundMessage
    // requires both: status === AI_ACTIVE AND no assignedModeratorId).
    //
    // Assigning a real moderator flips status to HUMAN_MODERATOR too — this
    // used to only set assignedModeratorId and leave status untouched, which
    // still correctly blocked the AI from replying (saveInboundMessage's
    // gate checks assignedModeratorId independently), but left the chat
    // list's status badge stuck showing "AI Active" since it reads status,
    // not assignedModeratorId.
    if (!moderatorId) {
      conversation.status = ConversationStatus.AI_ACTIVE;
      this.logger.log(`Conversation ${conversationId} reassigned to AI (unassigned + status=ai_active)`);
    } else {
      conversation.status = ConversationStatus.HUMAN_MODERATOR;
      this.logger.log(`Conversation ${conversationId} assigned to moderator=${moderatorId} (status=human_moderator)`);
    }

    const saved = await this.conversationRepo.save(conversation);

    const conversationWithCustomer = await this.conversationRepo.findOne({
      where: { id: saved.id },
      relations: { customer: true },
    });
    if (conversationWithCustomer) {
      this.chatGateway.emitConversationUpdated(toConversationDto(conversationWithCustomer));
    }

    return { id: saved.id, assignedModeratorId: saved.assignedModeratorId, status: saved.status };
  }

  private async assertConversationExists(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}
