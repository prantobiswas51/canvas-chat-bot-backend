import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';
import { Customer } from '../chat/entities/customer.entity';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { AdReferral, Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Message, MessageAttachment, MessageSender } from '../chat/entities/message.entity';
import { ChatGateway } from '../realtime/chat.gateway';
import { toConversationDto, toMessageDto } from '../chat/chat.mappers';
import { MessengerApiService } from '../messenger/messenger-api.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { GeminiService, GeminiTool, GeminiHistoryImage } from '../ai/gemini.service';
import { OpenAiService } from '../ai/openai.service';
import { ClaudeService } from '../ai/claude.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { TranscriptionService } from '../ai/transcription.service';
import type { AiChatService } from '../ai/ai-chat.interface';
import { ProductsApiService } from '../products/products-api.service';
import { OrdersService } from '../orders/orders.service';

// Friendlier than showing the raw provider ID (e.g. a 20-digit Messenger PSID)
// while the real name can't be resolved yet.
function fallbackCustomerName(externalUserId: string): string {
  return `Customer •${externalUserId.slice(-4)}`;
}

function isUnresolvedName(name: string, externalUserId: string): boolean {
  return name === externalUserId || name === fallbackCustomerName(externalUserId);
}

const IMAGE_EXTENSION_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// Converts a stored MessageAttachment into what Gemini needs to actually
// see the picture: inline base64 data (WhatsApp's downloaded images, stored
// as a data: URI) or a fileUri Gemini fetches itself (Messenger's CDN links).
function toGeminiImage(attachment?: MessageAttachment): GeminiHistoryImage | undefined {
  if (!attachment || attachment.type !== 'image') return undefined;

  const dataUriMatch = attachment.url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { mimeType: dataUriMatch[1], data: dataUriMatch[2] };
  }

  const extension = attachment.url.split('.').pop()?.split(/[?#]/)[0]?.toLowerCase();
  const mimeType = (extension && IMAGE_EXTENSION_MIME_TYPES[extension]) || 'image/jpeg';
  return { mimeType, fileUri: attachment.url };
}

interface WhatsappContact {
  profile?: { name?: string };
  wa_id: string;
}

// Only present on the first message of a session that started from a
// Click-to-WhatsApp ad — requires "Ads Attribution" to be turned on in
// WhatsApp Manager > Business Settings, otherwise Meta omits it entirely.
interface WhatsappReferral {
  source_id?: string; // the ad ID
  source_type?: string; // 'ad'
  source_url?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  ctwa_clid?: string;
}

interface WhatsappInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  referral?: WhatsappReferral;
}

function normalizeWhatsappReferral(referral?: WhatsappReferral): AdReferral | undefined {
  if (!referral) return undefined;
  return {
    platform: 'whatsapp',
    source: referral.source_type,
    adId: referral.source_id,
    headline: referral.headline,
    body: referral.body,
    mediaUrl: referral.image_url || referral.video_url,
    ctwaClid: referral.ctwa_clid,
  };
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

// Only present on the first message of a session opened via a Click-to-
// Messenger ad ("source": "ADS") or an m.me link ("source": "SHORTLINK") —
// we only care about the former for attribution.
interface MessengerReferral {
  source?: string;
  type?: string;
  ad_id?: string;
  ref?: string;
  ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string };
}

interface MessengerWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    messaging?: Array<{
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        attachments?: Array<{ type: string; payload?: { url?: string } }>;
        referral?: MessengerReferral;
      };
    }>;
  }>;
}

function normalizeMessengerReferral(referral?: MessengerReferral): AdReferral | undefined {
  if (!referral || referral.source !== 'ADS') return undefined;
  return {
    platform: 'messenger',
    source: referral.source,
    adId: referral.ad_id,
    headline: referral.ads_context_data?.ad_title,
    mediaUrl: referral.ads_context_data?.photo_url || referral.ads_context_data?.video_url,
  };
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
    private readonly whatsappApiService: WhatsappApiService,
    private readonly dispatchService: DispatchService,
    private readonly geminiService: GeminiService,
    private readonly openAiService: OpenAiService,
    private readonly claudeService: ClaudeService,
    private readonly productsApiService: ProductsApiService,
    private readonly ordersService: OrdersService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly transcriptionService: TranscriptionService,
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
    await this.captureAdReferralIfPresent(conversation, normalizeWhatsappReferral(waMessage.referral));

    let content: string;
    let attachment: MessageAttachment | undefined;

    if (waMessage.type === 'text' && waMessage.text) {
      content = waMessage.text.body;
    } else if (waMessage.type === 'image' && waMessage.image) {
      const media = await this.whatsappApiService.fetchMedia(waMessage.image.id);
      content = waMessage.image.caption || '📷 Photo';
      attachment = media
        ? { name: 'Photo', url: `data:${media.mimeType};base64,${media.base64}`, type: 'image' }
        : undefined;
      if (!media) content = `${content} (couldn't download image)`;
    } else if (waMessage.type === 'audio' && waMessage.audio) {
      const media = await this.whatsappApiService.fetchMedia(waMessage.audio.id);
      content = await this.transcribeVoiceNote(media);
      attachment = media
        ? { name: 'Voice message', url: `data:${media.mimeType};base64,${media.base64}`, type: 'audio' }
        : undefined;
    } else if (waMessage.type === 'video' && waMessage.video) {
      content = waMessage.video.caption || '[Video message — not previewable yet]';
    } else if (waMessage.type === 'document' && waMessage.document) {
      content = waMessage.document.caption || `📎 ${waMessage.document.filename || 'Document'}`;
    } else {
      content = `[Unsupported message type: ${waMessage.type}]`;
    }

    await this.saveInboundMessage(conversation, customer, content, waMessage.id, attachment);
  }

  // Downloads (if needed) and transcribes a voice note via Whisper, folding
  // the result straight into the message's stored "content" text so it
  // flows into the AI's history exactly like anything the customer typed —
  // falls back to a plain placeholder if the download or transcription
  // fails, same pattern as the image branch above.
  private async transcribeVoiceNote(media?: { base64: string; mimeType: string }): Promise<string> {
    if (!media) return "🎤 Voice message (couldn't download audio)";
    const buffer = Buffer.from(media.base64, 'base64');
    const transcript = await this.transcriptionService.transcribe(buffer, media.mimeType, 'voice-note');
    return transcript ? `🎤 "${transcript}"` : '🎤 Voice message (transcription unavailable)';
  }

  // Messenger's audio attachments are a direct CDN URL (unlike WhatsApp's
  // authenticated media-ID lookup), so download it ourselves before handing
  // the bytes to Whisper.
  private async transcribeVoiceNoteFromUrl(url: string): Promise<string> {
    try {
      const res = await fetch(url);
      if (!res.ok) return "🎤 Voice message (couldn't download audio)";
      const mimeType = res.headers.get('content-type') || 'audio/mp4';
      const buffer = Buffer.from(await res.arrayBuffer());
      const transcript = await this.transcriptionService.transcribe(buffer, mimeType, 'voice-note');
      return transcript ? `🎤 "${transcript}"` : '🎤 Voice message (transcription unavailable)';
    } catch (err) {
      this.logger.warn(`Messenger voice note download failed: ${(err as Error).message}`);
      return "🎤 Voice message (couldn't download audio)";
    }
  }

  // Persists ad-attribution data the first (and only the first) time it
  // shows up on a conversation, and drops a visible SYSTEM message so agents
  // see the "started from an ad" context right in the chat thread without
  // needing a dedicated UI. Later messages in the same conversation never
  // carry referral data (Meta only attaches it to the session-opening
  // message), so this only ever runs once per conversation.
  private async captureAdReferralIfPresent(conversation: Conversation, referral?: AdReferral): Promise<void> {
    if (!referral || conversation.adReferral) return;

    conversation.adReferral = referral;
    await this.conversationRepo.save(conversation);

    const label = referral.headline || (referral.adId ? `Ad ${referral.adId}` : 'an ad');
    const suffix = referral.adId && referral.headline ? ` (Ad ID: ${referral.adId})` : '';
    await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        senderType: MessageSender.SYSTEM,
        content: `🎯 Conversation started from an ad — ${label}${suffix}`,
      }),
    );
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
    message: {
      mid: string;
      text?: string;
      attachments?: Array<{ type: string; payload?: { url?: string } }>;
      referral?: MessengerReferral;
    },
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
    await this.captureAdReferralIfPresent(conversation, normalizeMessengerReferral(message.referral));

    let content: string;
    let attachment: MessageAttachment | undefined;

    const firstAttachment = message.attachments?.[0];
    if (message.text) {
      content = message.text;
    } else if (firstAttachment?.payload?.url) {
      // Meta's CDN URL — usable directly in <img src>, unlike WhatsApp's
      // short-lived authenticated media URLs.
      if (firstAttachment.type === 'image') {
        content = '📷 Photo';
        attachment = { name: 'Photo', url: firstAttachment.payload.url, type: 'image' };
      } else if (firstAttachment.type === 'audio') {
        content = await this.transcribeVoiceNoteFromUrl(firstAttachment.payload.url);
        attachment = { name: 'Voice message', url: firstAttachment.payload.url, type: 'audio' };
      } else {
        content = `📎 ${firstAttachment.type}`;
        attachment = { name: firstAttachment.type, url: firstAttachment.payload.url, type: 'file' };
      }
    } else {
      content = '[Unsupported message type]';
    }

    await this.saveInboundMessage(conversation, customer, content, message.mid, attachment);
  }

  // Saves the inbound message, patches the conversation's preview/unread
  // fields, and pushes both over the socket so an already-open chat updates
  // live instead of waiting for a manual refresh.
  private async saveInboundMessage(
    conversation: Conversation,
    customer: Customer,
    content: string,
    externalMessageId: string,
    attachment?: MessageAttachment,
  ): Promise<void> {
    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        senderType: MessageSender.CUSTOMER,
        senderName: customer.name,
        content,
        externalMessageId,
        attachment,
      }),
    );

    conversation.lastMessage = content;
    conversation.lastMessageAt = new Date();
    conversation.unreadCount += 1;
    await this.conversationRepo.save(conversation);

    this.chatGateway.emitNewMessage(toMessageDto(saved));

    conversation.customer = customer;
    this.chatGateway.emitConversationUpdated(toConversationDto(conversation));

    // Three independent gates, all must pass for the AI to reply:
    //  1. Global kill switch (Settings → AI Instructions → "Enable AI by
    //     default") — off means the AI never replies to anything, full stop.
    //  2. Per-conversation status — an agent may have explicitly taken over
    //     this one chat via "Take Over (Human Mode)".
    //  3. Not already claimed by a specific moderator — assigning someone
    //     to a conversation means it's theirs even if status still says
    //     AI_ACTIVE; the AI shouldn't barge back in.
    const aiSettings = await this.aiSettingsService.get();
    const aiShouldReply =
      aiSettings.aiEnabledByDefault &&
      conversation.status === ConversationStatus.AI_ACTIVE &&
      !conversation.assignedModeratorId;

    if (aiShouldReply) {
      const provider = this.resolveAiProvider(aiSettings.aiProvider);
      await this.generateAndSendAiReply(conversation, customer, aiSettings.customInstructions, provider);
    }
  }

  // Settings → AI Instructions → provider dropdown picks this live, per
  // message — no restart needed since it's read from the DB each time
  // rather than resolved once at boot.
  private resolveAiProvider(provider: string): AiChatService {
    if (provider === 'claude') return this.claudeService;
    if (provider === 'gemini') return this.geminiService;
    return this.openAiService;
  }

  // Only fires when the conditions in saveInboundMessage's aiShouldReply
  // check pass; a human agent's own reply (via ChatService.sendAgentMessage)
  // never routes through this.
  private async generateAndSendAiReply(
    conversation: Conversation,
    customer: Customer,
    customInstructions: string | undefined,
    aiChatService: AiChatService,
  ): Promise<void> {
    const recent = await this.messageRepo.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'DESC' },
      take: 12,
    });

    const history = recent
      .slice()
      .reverse()
      .map((m) => ({
        role: m.senderType === MessageSender.CUSTOMER ? ('user' as const) : ('model' as const),
        text: m.content,
        // Only the customer's own photos are worth Gemini "seeing" — an
        // agent/AI message never has an attachment that needs interpreting.
        image: m.senderType === MessageSender.CUSTOMER ? toGeminiImage(m.attachment) : undefined,
      }));

    const baseSystemPrompt =
      'You are Canvas AI Bot, a friendly customer support assistant for Canvas Art Supplies, an online art & canvas ' +
      'supplies store. Keep replies short (1-3 sentences), warm, and helpful. Match the language/style the customer ' +
      "used (English, Bengali, or Banglish). Use the search_products tool whenever the customer asks about a specific " +
      "product, SKU, price, or stock — never guess those details. If the tool errors or a product isn't found, say a " +
      "human teammate will confirm shortly instead of making something up. Use the create_order tool once the " +
      'customer has clearly decided to buy a specific product (SKU) and has given you their full name, delivery ' +
      'address, and phone number — confirm these three details back to the customer before calling the tool if any ' +
      "are missing or unclear. Never invent a name, address, or phone number. After the tool succeeds, tell the " +
      'customer their invoice ID and that the order is being processed. Customers may send photos — of a product ' +
      'they want, a damaged item, a receipt, or their own artwork. Look at the image and respond to what it ' +
      "actually shows; if it's a product, use search_products to match it up rather than guessing details. " +
      'Customers may also send voice notes — these arrive as a 🎤 message with the transcribed text in quotes; ' +
      'treat that transcript exactly like a typed message and reply normally (transcription is occasionally ' +
      "imperfect, so if it's garbled or unclear, just ask the customer to clarify or type it instead).";

    // Team-editable additions (Settings → AI Instructions) layered on top of
    // the base behavior above — store policies, tone tweaks, extra rules, etc.
    const systemPrompt = customInstructions?.trim()
      ? `${baseSystemPrompt}\n\nAdditional instructions from the store team (follow these too):\n${customInstructions.trim()}`
      : baseSystemPrompt;

    const tools: GeminiTool[] = [
      {
        name: 'search_products',
        description:
          "Searches the store's product catalog by SKU/product code or keyword (e.g. 'PMPP6001' or 'acrylic paint set'). " +
          'Returns matching product(s) with details such as name, price, stock, and description.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Product SKU, code, name, or search keyword' },
          },
          required: ['query'],
        },
        execute: (args) => this.productsApiService.search(String(args.query ?? '')),
      },
      {
        name: 'create_order',
        description:
          'Creates a new order once the customer has confirmed they want to buy a specific product and provided ' +
          'their full name, delivery address, and phone number. Do not guess or invent any of these — ask the ' +
          "customer if anything is missing. Returns the created order's invoice ID.",
        parameters: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING', description: "Customer's full name for the order" },
            address: { type: 'STRING', description: 'Delivery address' },
            phone: { type: 'STRING', description: 'Contact phone number' },
            productSku: { type: 'STRING', description: 'SKU of the product being ordered (from search_products)' },
            quantity: { type: 'INTEGER', description: 'Quantity ordered — defaults to 1 if not specified' },
            notes: { type: 'STRING', description: 'Any extra notes about the order, e.g. color/size preference' },
          },
          required: ['name', 'address', 'phone', 'productSku'],
        },
        execute: async (args) => {
          const order = await this.ordersService.createOrder({
            customerName: String(args.name ?? ''),
            address: String(args.address ?? ''),
            phone: String(args.phone ?? ''),
            productSku: String(args.productSku ?? ''),
            quantity: args.quantity ? Number(args.quantity) : 1,
            notes: args.notes ? String(args.notes) : undefined,
            conversationId: conversation.id,
            customerId: customer.id,
            createdByAi: true,
          });

          // Visible marker in the thread so a human moderator can spot
          // AI-placed orders at a glance without re-reading the conversation.
          const systemMessage = await this.messageRepo.save(
            this.messageRepo.create({
              conversationId: conversation.id,
              senderType: MessageSender.SYSTEM,
              senderName: 'System',
              content: `🧾 Order ${order.invoiceId} created by AI Bot — SKU ${order.productSku} × ${order.quantity}`,
            }),
          );
          this.chatGateway.emitNewMessage(toMessageDto(systemMessage));

          return { invoiceId: order.invoiceId, status: order.status };
        },
      },
    ];

    const reply = await aiChatService.generateReply(systemPrompt, history, tools);
    if (!reply) return;

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        senderType: MessageSender.AI_BOT,
        senderName: 'Canvas AI Bot',
        content: reply,
      }),
    );

    conversation.lastMessage = reply;
    conversation.lastMessageAt = saved.createdAt;
    await this.conversationRepo.save(conversation);

    this.chatGateway.emitNewMessage(toMessageDto(saved));
    conversation.customer = customer;
    this.chatGateway.emitConversationUpdated(toConversationDto(conversation));

    await this.dispatchService.sendReply(conversation, reply);
  }

  private async resolveConversation(customerId: string, channelAccount: ChannelAccount): Promise<Conversation> {
    const existing = await this.conversationRepo.findOne({
      where: { customerId, channelAccountId: channelAccount.id },
      order: { createdAt: 'DESC' },
    });
    if (existing) return existing;

    // New conversations always start AI_ACTIVE at the per-conversation
    // level — the Settings → AI Instructions toggle is a separate runtime
    // gate (checked in saveInboundMessage) that can block a reply even when
    // status is AI_ACTIVE, not a creation-time default.
    return this.conversationRepo.save(
      this.conversationRepo.create({
        customerId,
        channelAccountId: channelAccount.id,
        channel: channelAccount.channel,
        status: ConversationStatus.AI_ACTIVE,
        unreadCount: 0,
      }),
    );
  }
}
