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
import { GeminiService, GeminiTool, GeminiHistoryImage, GeminiHistoryTurn } from './gemini.service';

// Everything below is deterministic, code-only trimming of what gets sent
// to Gemini per reply — no extra AI call involved (a real conversation
// summary would need Gemini to generate it, which means *more* calls, not
// fewer, so this deliberately isn't that). Three independent caps:

// 1. How many past messages get sent as context at all. Fewer turns =
// smaller request. Older messages beyond this just aren't part of the
// AI's memory for that reply — the full thread is still visible to human
// moderators in the chat UI regardless, this only affects what Gemini sees.
const HISTORY_TURN_LIMIT = 8;

// 2. How many of the most recent customer-image turns actually get the
// image bytes attached, out of the history window above. Older photos
// still show up as text ("📷 Photo" is part of the message content), just
// without the pixels re-sent — without this cap, one photo sitting in the
// lookback window gets re-downloaded/re-uploaded to Gemini on every single
// subsequent reply in that conversation until it ages out, multiplying
// image data cost for no benefit once the conversation's moved on.
const MAX_IMAGE_HISTORY_TURNS = 3;

// 3. How much text from a single message is sent verbatim. Customers
// occasionally paste long addresses/order lists/pasted receipts — cap it so
// one oversized message doesn't dominate the payload.
const MAX_MESSAGE_CHARS = 600;

function truncateForGemini(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated, ${text.length} chars total]`;
}

// Converts a stored MessageAttachment into what Gemini needs to actually
// see the picture — always inline base64 data now, never fileUri:
//  - WhatsApp images are already stored as a data: URI (downloaded at
//    ingestion time) — just parse it back out.
//  - Messenger images are stored as the raw Facebook CDN URL. Passing that
//    straight through as fileData.fileUri relies on Gemini fetching it
//    server-side, which is unreliable in practice (fileUri support for
//    arbitrary external URLs is a newer, model-version-gated Gemini
//    feature, and Facebook's CDN links are signed/time-limited) — that's
//    the "fails whenever there's an image" bug. Downloading it ourselves
//    and inlining as base64 removes that dependency entirely, same as the
//    WhatsApp path already does reliably.
async function resolveGeminiImage(
  attachment: MessageAttachment | undefined,
  logger: Logger,
): Promise<GeminiHistoryImage | undefined> {
  if (!attachment || attachment.type !== 'image') return undefined;

  const dataUriMatch = attachment.url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { mimeType: dataUriMatch[1], data: dataUriMatch[2] };
  }

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      logger.warn(`Image download failed (${res.status}) for ${attachment.url} — sending reply without it`);
      return undefined;
    }
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buffer.toString('base64') };
  } catch (err) {
    logger.warn(`Image download threw for ${attachment.url}: ${(err as Error).message} — sending reply without it`);
    return undefined;
  }
}

// Everything needed to actually generate + send one AI reply. Pulled out of
// WebhookService so it can run inside the ai-reply queue worker
// (src/queue/ai-reply.processor.ts) instead of inline inside the webhook
// HTTP handler — ingestion (fast: save message, dedupe, emit socket events)
// and AI generation (slow: LLM round-trip, possibly several tool-call
// rounds) are decoupled by the queue in between.
//
// Gemini-only right now (OpenAI/Claude removed while debugging the 429s) —
// every step here is logged with a STEP n/7 tag so a failure's exact
// position in the pipeline is obvious from the logs alone.
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
    private readonly productsApiService: ProductsApiService,
    private readonly ordersService: OrdersService,
  ) {}

  // Only called by AiReplyProcessor, which itself only runs jobs enqueued
  // from WebhookService's aiShouldReply gate; a human agent's own reply (via
  // ChatService.sendAgentMessage) never routes through this. Throws
  // RetryableAiError (propagated from GeminiService) on transient provider
  // failures — the caller (the processor) is responsible for letting that
  // surface so BullMQ marks the job failed.
  async generateAndSendAiReply(
    conversation: Conversation,
    customer: Customer,
    customInstructions: string | undefined,
  ): Promise<void> {
    const tag = `conversation=${conversation.id}`;
    this.logger.log(`[STEP 1/7] ${tag} — fetching recent message history`);

    const recent = await this.messageRepo.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'DESC' },
      take: HISTORY_TURN_LIMIT,
    });
    const chronological = recent.slice().reverse();

    // Only the most recent MAX_IMAGE_HISTORY_TURNS customer photos actually
    // get their bytes resolved/attached — see the comment on that constant.
    const imageEligibleIds = new Set(
      chronological
        .filter((m) => m.senderType === MessageSender.CUSTOMER && m.attachment?.type === 'image')
        .slice(-MAX_IMAGE_HISTORY_TURNS)
        .map((m) => m.id),
    );

    this.logger.log(`[STEP 1/7] ${tag} — resolving image(s) for ${imageEligibleIds.size} eligible turn(s)`);

    const history: GeminiHistoryTurn[] = [];
    for (const m of chronological) {
      const shouldResolveImage = m.senderType === MessageSender.CUSTOMER && imageEligibleIds.has(m.id);
      history.push({
        role: m.senderType === MessageSender.CUSTOMER ? ('user' as const) : ('model' as const),
        text: truncateForGemini(m.content),
        // Only the customer's own recent photos are worth Gemini "seeing" —
        // an agent/AI message never has an attachment that needs
        // interpreting, and older photos are capped out above.
        image: shouldResolveImage ? await resolveGeminiImage(m.attachment, this.logger) : undefined,
      });
    }

    this.logger.log(`[STEP 1/7] ${tag} — loaded ${history.length} history turn(s)`);
    this.logger.log(`[STEP 2/7] ${tag} — building system prompt`);

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

    this.logger.log(`[STEP 3/7] ${tag} — registering tools (search_products, create_order)`);

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

    this.logger.log(`[STEP 4/7] ${tag} — calling Gemini (generateReply)`);
    // NOTE: generateReply can throw RetryableAiError here — deliberately not
    // caught, so it propagates to AiReplyProcessor and fails the BullMQ job.
    const reply = await this.geminiService.generateReply(systemPrompt, history, tools);

    if (!reply) {
      this.logger.warn(`[STEP 4/7] ${tag} — Gemini returned no reply (empty/safety-blocked) — stopping here`);
      return;
    }
    this.logger.log(`[STEP 4/7] ${tag} — Gemini replied (${reply.length} chars)`);

    this.logger.log(`[STEP 5/7] ${tag} — saving AI message + updating conversation`);
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

    this.logger.log(`[STEP 6/7] ${tag} — emitting socket events`);
    this.chatGateway.emitNewMessage(toMessageDto(saved));
    conversation.customer = customer;
    this.chatGateway.emitConversationUpdated(toConversationDto(conversation));

    this.logger.log(`[STEP 7/7] ${tag} — dispatching reply to channel`);
    await this.dispatchService.sendReply(conversation, reply);
    this.logger.log(`[STEP 7/7] ${tag} — done, all 7 steps completed`);
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
