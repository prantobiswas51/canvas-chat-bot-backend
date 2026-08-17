import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { ChannelType } from '../chat/entities/channel-account.entity';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { MessengerApiService } from '../messenger/messenger-api.service';

// Shared by ChatService (agent-typed replies) and WebhookService (AI-generated
// replies) — one place that knows how to actually deliver a reply out to the
// customer's channel, regardless of who/what produced the message.
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @InjectRepository(CustomerChannelIdentity)
    private readonly identityRepo: Repository<CustomerChannelIdentity>,
    private readonly whatsappApiService: WhatsappApiService,
    private readonly messengerApiService: MessengerApiService,
  ) {}

  // Best-effort — the message is always saved locally by the caller first, so
  // a delivery failure here is logged, never thrown.
  async sendReply(conversation: Conversation, content: string): Promise<void> {
    if (!conversation.channelAccountId) return;
    if (conversation.channel !== ChannelType.WHATSAPP && conversation.channel !== ChannelType.MESSENGER) return;

    const identity = await this.identityRepo.findOne({
      where: { customerId: conversation.customerId, channelAccountId: conversation.channelAccountId },
    });

    if (!identity) {
      this.logger.warn(
        `No customer_channel_identity for customer=${conversation.customerId} — cannot deliver to ${conversation.channel}`,
      );
      return;
    }

    try {
      if (conversation.channel === ChannelType.WHATSAPP) {
        await this.whatsappApiService.sendText(identity.externalUserId, content);
      } else {
        await this.messengerApiService.sendText(identity.externalUserId, content);
      }
    } catch (err) {
      this.logger.error(`Failed to deliver ${conversation.channel} message: ${(err as Error).message}`);
    }
  }
}
