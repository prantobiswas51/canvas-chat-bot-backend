import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { Message, MessageSender } from './entities/message.entity';
import { ChannelType } from './entities/channel-account.entity';
import { CustomerChannelIdentity } from './entities/customer-channel-identity.entity';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { MessengerApiService } from '../messenger/messenger-api.service';
import { ChatGateway } from '../realtime/chat.gateway';
import { toConversationDto, toMessageDto } from './chat.mappers';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(CustomerChannelIdentity)
    private readonly identityRepo: Repository<CustomerChannelIdentity>,
    private readonly whatsappApiService: WhatsappApiService,
    private readonly messengerApiService: MessengerApiService,
    private readonly chatGateway: ChatGateway,
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
      if (conversation.channel === ChannelType.WHATSAPP) {
        await this.dispatchWhatsappReply(conversation, dto.content);
      } else if (conversation.channel === ChannelType.MESSENGER) {
        await this.dispatchMessengerReply(conversation, dto.content);
      }
    }

    return messageDto;
  }

  // Best-effort external delivery — the message is already saved locally, so a
  // delivery failure here shouldn't fail the request, just gets logged.
  private async dispatchWhatsappReply(conversation: Conversation, content: string): Promise<void> {
    if (!conversation.channelAccountId) return;

    const identity = await this.identityRepo.findOne({
      where: { customerId: conversation.customerId, channelAccountId: conversation.channelAccountId },
    });

    if (!identity) {
      this.logger.warn(
        `No customer_channel_identity for customer=${conversation.customerId} — cannot deliver to WhatsApp`,
      );
      return;
    }

    try {
      await this.whatsappApiService.sendText(identity.externalUserId, content);
    } catch (err) {
      this.logger.error(`Failed to deliver WhatsApp message: ${(err as Error).message}`);
    }
  }

  private async dispatchMessengerReply(conversation: Conversation, content: string): Promise<void> {
    if (!conversation.channelAccountId) return;

    const identity = await this.identityRepo.findOne({
      where: { customerId: conversation.customerId, channelAccountId: conversation.channelAccountId },
    });

    if (!identity) {
      this.logger.warn(
        `No customer_channel_identity for customer=${conversation.customerId} — cannot deliver to Messenger`,
      );
      return;
    }

    try {
      await this.messengerApiService.sendText(identity.externalUserId, content);
    } catch (err) {
      this.logger.error(`Failed to deliver Messenger message: ${(err as Error).message}`);
    }
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

  private async assertConversationExists(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }
}
