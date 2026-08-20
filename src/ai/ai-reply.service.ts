import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { Customer } from '../chat/entities/customer.entity';
import { Message, MessageAttachment, MessageSender } from '../chat/entities/message.entity';
import { ChatGateway } from '../realtime/chat.gateway';
import { toConversationDto, toMessageDto } from '../chat/chat.mappers';
import { DispatchService } from '../dispatch/dispatch.service';
import { ProductsApiService } from '../products/products-api.service';
import { OrdersService } from '../orders/orders.service';
import { GeminiService, GeminiTool, GeminiHistoryImage } from './gemini.service';
import { OpenAiService } from './openai.service';
import { ClaudeService } from './claude.service';
import type { AiChatService } from './ai-chat.interface';

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

// Everything needed to actually generate + send one AI reply. Pulled out of
// WebhookService so it can run inside the ai-reply queue worker
// (src/queue/ai-reply.processor.ts) instead of inline inside the webhook
// HTTP handler — ingestion (fast: save message, dedupe, emit socket events)
// and AI generation (slow: LLM round-trip, possibly several tool-call
// rounds) are decoupled by the queue in between.
@Injectable()
export class AiReplyService {
  private readonly logger = new Logger(AiReplyService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly chatGateway: ChatGateway,
    private readonly dispatchService: DispatchService,
    private readonly geminiService: GeminiService,
    private readonly openAiService: OpenAiService,
    private readonly claudeService: ClaudeService,
    private readonly productsApiService: ProductsApiService,
    private readonly ordersService: OrdersService,
  ) {}

  // Settings → AI Instructions → provider dropdown picks this live, per
  // message — no restart needed since it's read from the DB each time
  // rather than resolved once at boot.
  resolveAiProvider(provider: string): AiChatService {
    if (provider === 'claude') return this.claudeService;
    if (provider === 'gemini') return this.geminiService;
    return this.openAiService;
  }

  // Only called by AiReplyProcessor, which itself only runs jobs enqueued
  // from WebhookService's aiShouldReply gate; a human agent's own reply (via
  // ChatService.sendAgentMessage) never routes through this. Throws
  // RetryableAiError (propagated from the AiChatService call) on transient
  // provider failures — the caller (the processor) is responsible for
  // letting that surface so BullMQ retries the job.
  async generateAndSendAiReply(
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

    this.logger.log(`Calling AI (${aiChatService.constructor.name}) for conversation=${conversation.id}...`);
    // NOTE: generateReply can throw RetryableAiError here — deliberately not
    // caught, so it propagates to AiReplyProcessor and fails the BullMQ job
    // for a retry with backoff instead of silently dropping the reply.
    const reply = await aiChatService.generateReply(systemPrompt, history, tools);
    if (!reply) {
      this.logger.warn(`AI returned no reply for conversation=${conversation.id} — nothing sent`);
      return;
    }
    this.logger.log(`AI reply generated for conversation=${conversation.id} (${reply.length} chars)`);

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

  // Posts a visible SYSTEM message when every retry attempt for a reply has
  // been exhausted, so a human moderator sees the conversation needs
  // attention instead of the customer just being left on read.
  async notifyReplyFailed(conversationId: string, reason: string): Promise<void> {
    const message = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId,
        senderType: MessageSender.SYSTEM,
        senderName: 'System',
        content: `⚠️ AI couldn't reply after several attempts (${reason}) — please check this conversation.`,
      }),
    );
    this.chatGateway.emitNewMessage(toMessageDto(message));
  }
}
