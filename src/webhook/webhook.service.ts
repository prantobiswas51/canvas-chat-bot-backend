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
import { AiSettingsService } from '../ai/ai-settings.service';
import { TranscriptionService } from '../ai/transcription.service';
import { AiReplyProducer } from '../queue/ai-reply.producer';

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
    private readonly aiSettingsService: AiSettingsService,
    private readonly transcriptionService: TranscriptionService,
    private readonly aiReplyProducer: AiReplyProducer,
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
    this.logger.log(`WhatsApp inbound: from=${waMessage.from} type=${waMessage.type} id=${waMessage.id}`);

    // De-dupe retried webhook deliveries — Meta resends on any non-2xx or timeout.
    const existing = await this.messageRepo.findOne({ where: { externalMessageId: waMessage.id } });
    if (existing) {
      this.logger.log(`Skipping duplicate WhatsApp message id=${waMessage.id} (already ingested)`);
      return;
    }

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

    await this.saveInboundMessage(conversation, customer, channelAccount, content, waMessage.id, attachment);
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

        // accessToken is select:false on the entity — list it explicitly to
        // actually get the Page's own token back (each Page has its own).
        const channelAccount = await this.channelAccountRepo.findOne({
          where: { channel: ChannelType.MESSENGER, externalAccountId: pageId },
          select: { id: true, channel: true, externalAccountId: true, displayName: true, accessToken: true, createdAt: true },
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
    this.logger.log(
      `Messenger inbound: psid=${senderPsid} page=${channelAccount.externalAccountId} mid=${message.mid}`,
    );

    // De-dupe retried webhook deliveries — Meta resends on any non-2xx or timeout.
    const existing = await this.messageRepo.findOne({ where: { externalMessageId: message.mid } });
    if (existing) {
      this.logger.log(`Skipping duplicate Messenger message mid=${message.mid} (already ingested)`);
      return;
    }

    // Messenger's webhook payload doesn't include the sender's profile name —
    // only the Page-scoped ID (PSID) — so resolve it via the User Profile API.
    const customer = await this.resolveCustomer(channelAccount.id, senderPsid, undefined, undefined, () =>
      this.messengerApiService.getUserProfile(senderPsid, channelAccount.accessToken),
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

    await this.saveInboundMessage(conversation, customer, channelAccount, content, message.mid, attachment);
  }

  // Saves the inbound message, patches the conversation's preview/unread
  // fields, and pushes both over the socket so an already-open chat updates
  // live instead of waiting for a manual refresh.
  private async saveInboundMessage(
    conversation: Conversation,
    customer: Customer,
    channelAccount: ChannelAccount,
    content: string,
    externalMessageId: string,
    attachment?: MessageAttachment,
  ): Promise<void> {
    const tag = `conversation=${conversation.id}`;
    this.logger.log(`[INGEST STEP 1/4] ${tag} — saving inbound customer message`);

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

    this.logger.log(`[INGEST STEP 2/4] ${tag} — emitting socket events`);
    this.chatGateway.emitNewMessage(toMessageDto(saved));

    conversation.customer = customer;
    // Not loaded via a relation here (conversation was fetched by ID only) —
    // attach it the same way .customer is, so the chat list can show which
    // connected Page/number this message came from.
    conversation.channelAccount = channelAccount;
    this.chatGateway.emitConversationUpdated(toConversationDto(conversation));

    // Three independent gates, all must pass for the AI to reply:
    //  1. Global kill switch (Settings → AI Instructions → "Enable AI by
    //     default") — off means the AI never replies to anything, full stop.
    //  2. Per-conversation status — an agent may have explicitly taken over
    //     this one chat via "Take Over (Human Mode)".
    //  3. Not already claimed by a specific moderator — assigning someone
    //     to a conversation means it's theirs even if status still says
    //     AI_ACTIVE; the AI shouldn't barge back in.
    this.logger.log(`[INGEST STEP 3/4] ${tag} — checking AI-should-reply gate`);
    const aiSettings = await this.aiSettingsService.get();
    const aiShouldReply =
      aiSettings.aiEnabledByDefault &&
      conversation.status === ConversationStatus.AI_ACTIVE &&
      !conversation.assignedModeratorId;

    if (aiShouldReply) {
      this.logger.log(`[INGEST STEP 4/4] ${tag} — gate passed, queuing AI reply job (provider=gemini)`);
      // Enqueue instead of generating inline — this is the point where the
      // webhook handler used to block for however long the LLM round-trip
      // took. Now it just pushes a job onto Redis (fast) and returns, so
      // Meta's webhook ack is never at risk of timing out, and the AI
      // Worker's capped concurrency (see AiReplyProcessor) smooths out
      // bursts instead of firing one AI call per message simultaneously.
      await this.aiReplyProducer.enqueue({ conversationId: conversation.id, customerId: customer.id });
    } else {
      const reason = !aiSettings.aiEnabledByDefault
        ? 'global AI toggle is off'
        : conversation.status !== ConversationStatus.AI_ACTIVE
          ? `conversation status is "${conversation.status}"`
          : 'conversation is assigned to a moderator';
      this.logger.log(`[INGEST STEP 4/4] ${tag} — gate failed, AI will NOT reply — reason="${reason}"`);
    }
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
