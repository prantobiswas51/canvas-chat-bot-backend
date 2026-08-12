import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';
import { Customer } from '../chat/entities/customer.entity';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Message, MessageSender } from '../chat/entities/message.entity';
import { ChatGateway } from '../realtime/chat.gateway';
import { toConversationDto, toMessageDto } from '../chat/chat.mappers';
import { MessengerApiService } from '../messenger/messenger-api.service';

// Friendlier than showing the raw provider ID (e.g. a 20-digit Messenger PSID)
// while the real name can't be resolved yet.
function fallbackCustomerName(externalUserId: string): string {
  return `Customer •${externalUserId.slice(-4)}`;
}

function isUnresolvedName(name: string, externalUserId: string): boolean {
  return name === externalUserId || name === fallbackCustomerName(externalUserId);
}

interface WhatsappContact {
  profile?: { name?: string };
  wa_id: string;
}

interface WhatsappInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WhatsappWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: {
        metadata?: { phone_number_id: string; display_phone_number?: string };
        contacts?: WhatsappContact[];
        messages?: WhatsappInboundMessage[];
      };
    }>;
  }>;
}

interface MessengerWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    messaging?: Array<{
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message?: { mid: string; text?: string; is_echo?: boolean };
    }>;
  }>;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectRepository(ChannelAccount)
    private readonly channelAccountRepo: Repository<ChannelAccount>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    @InjectRepository(CustomerChannelIdentity)
    private readonly identityRepo: Repository<CustomerChannelIdentity>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly chatGateway: ChatGateway,
    private readonly messengerApiService: MessengerApiService,
  ) {}

  async handleWhatsappEvent(body: WhatsappWebhookPayload): Promise<void> {
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const { value } = change;
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const channelAccount = await this.channelAccountRepo.findOne({
          where: { channel: ChannelType.WHATSAPP, externalAccountId: phoneNumberId },
        });

        if (!channelAccount) {
          this.logger.warn(
            `No channel_accounts row for WhatsApp phone_number_id=${phoneNumberId} — run "npm run setup:whatsapp-channel" first. Dropping event.`,
          );
          continue;
        }

        for (const waMessage of value.messages ?? []) {
          await this.ingestMessage(channelAccount, value.contacts ?? [], waMessage);
        }
      }
    }
  }

  private async ingestMessage(
    channelAccount: ChannelAccount,
    contacts: WhatsappContact[],
    waMessage: WhatsappInboundMessage,
  ): Promise<void> {
    // De-dupe retried webhook deliveries — Meta resends on any non-2xx or timeout.
    const existing = await this.messageRepo.findOne({ where: { externalMessageId: waMessage.id } });
    if (existing) return;

    const contact = contacts.find((c) => c.wa_id === waMessage.from);
    const customer = await this.resolveCustomer(
      channelAccount.id,
      waMessage.from,
      contact?.profile?.name,
      waMessage.from,
    );
    const conversation = await this.resolveConversation(customer.id, channelAccount);

    const content =
      waMessage.type === 'text' && waMessage.text
        ? waMessage.text.body
        : `[Unsupported message type: ${waMessage.type}]`;

    await this.saveInboundMessage(conversation, customer, content, waMessage.id);
  }

  private async resolveCustomer(
    channelAccountId: string,
    externalUserId: string,
    name?: string,
    phone?: string,
    resolveName?: () => Promise<string | undefined>,
  ): Promise<Customer> {
    const identity = await this.identityRepo.findOne({
      where: { channelAccountId, externalUserId },
      relations: { customer: true },
    });

    if (identity) {
      const { customer } = identity;
      // Self-heal customers that were created before a name could be resolved
      // (e.g. Messenger contacts saved with a placeholder name because the
      // User Profile API wasn't approved yet) — retries on every message
      // until resolveName() starts succeeding, no manual backfill needed.
      if (isUnresolvedName(customer.name, externalUserId) && resolveName) {
        const resolvedName = await resolveName();
        if (resolvedName && resolvedName !== customer.name) {
          customer.name = resolvedName;
          await this.customerRepo.save(customer);
        } else if (customer.name === externalUserId) {
          // Resolution still failed — at least upgrade the raw ID to the
          // nicer placeholder now instead of waiting for it to succeed.
          customer.name = fallbackCustomerName(externalUserId);
          await this.customerRepo.save(customer);
        }
      }
      return customer;
    }

    const resolvedName = name ?? (resolveName ? await resolveName() : undefined);

    const customer = await this.customerRepo.save(
      this.customerRepo.create({ name: resolvedName || fallbackCustomerName(externalUserId), phone, tags: [] }),
    );

    await this.identityRepo.save(
      this.identityRepo.create({ customerId: customer.id, channelAccountId, externalUserId }),
    );

    return customer;
  }

  async handleMessengerEvent(body: MessengerWebhookPayload): Promise<void> {
    if (body.object !== 'page') return;

    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        // Skip echoes (our own outbound sends bounced back) and non-message
        // events (postbacks, delivery/read receipts, etc.) — nothing to ingest.
        if (!event.message || event.message.is_echo) continue;

        const pageId = event.recipient?.id;
        if (!pageId) continue;

        const channelAccount = await this.channelAccountRepo.findOne({
          where: { channel: ChannelType.MESSENGER, externalAccountId: pageId },
        });

        if (!channelAccount) {
          this.logger.warn(
            `No channel_accounts row for Messenger page_id=${pageId} — run "npm run setup:messenger-channel" first. Dropping event.`,
          );
          continue;
        }

        await this.ingestMessengerMessage(channelAccount, event.sender.id, event.message);
      }
    }
  }

  private async ingestMessengerMessage(
    channelAccount: ChannelAccount,
    senderPsid: string,
    message: { mid: string; text?: string },
  ): Promise<void> {
    // De-dupe retried webhook deliveries — Meta resends on any non-2xx or timeout.
    const existing = await this.messageRepo.findOne({ where: { externalMessageId: message.mid } });
    if (existing) return;

    // Messenger's webhook payload doesn't include the sender's profile name —
    // only the Page-scoped ID (PSID) — so resolve it via the User Profile API.
    const customer = await this.resolveCustomer(channelAccount.id, senderPsid, undefined, undefined, () =>
      this.messengerApiService.getUserProfile(senderPsid),
    );
    const conversation = await this.resolveConversation(customer.id, channelAccount);

    const content = message.text ?? '[Unsupported message type]';

    await this.saveInboundMessage(conversation, customer, content, message.mid);
  }

  // Saves the inbound message, patches the conversation's preview/unread
  // fields, and pushes both over the socket so an already-open chat updates
  // live instead of waiting for a manual refresh.
  private async saveInboundMessage(
    conversation: Conversation,
    customer: Customer,
    content: string,
    externalMessageId: string,
  ): Promise<void> {
    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        senderType: MessageSender.CUSTOMER,
        senderName: customer.name,
        content,
        externalMessageId,
      }),
    );

    conversation.lastMessage = content;
    conversation.lastMessageAt = new Date();
    conversation.unreadCount += 1;
    await this.conversationRepo.save(conversation);

    this.chatGateway.emitNewMessage(toMessageDto(saved));

    conversation.customer = customer;
    this.chatGateway.emitConversationUpdated(toConversationDto(conversation));
  }

  private async resolveConversation(customerId: string, channelAccount: ChannelAccount): Promise<Conversation> {
    const existing = await this.conversationRepo.findOne({
      where: { customerId, channelAccountId: channelAccount.id },
      order: { createdAt: 'DESC' },
    });
    if (existing) return existing;

    return this.conversationRepo.save(
      this.conversationRepo.create({
        customerId,
        channelAccountId: channelAccount.id,
        channel: channelAccount.channel,
        status: ConversationStatus.HUMAN_MODERATOR,
        unreadCount: 0,
      }),
    );
  }
}
