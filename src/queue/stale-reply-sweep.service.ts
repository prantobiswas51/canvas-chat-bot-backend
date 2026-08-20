import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Message, MessageSender } from '../chat/entities/message.entity';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiReplyProducer } from './ai-reply.producer';

// Safety net for the "Webhook → Redis/Queue → AI Worker" pipeline — if a
// message ever falls through the cracks (a job failed after exhausting its
// 3 retries, a Redis hiccup dropped a job, a bug, whatever), this is what
// eventually notices and re-tries it, instead of the customer being left on
// read forever. Runs independently of any single conversation/job already
// in memory, so it has to re-derive "is this stuck?" from the DB each time.
const STALE_AFTER_MS = 2 * 60 * 1000; // don't touch anything newer than this — let normal debounce/queue flow handle it first
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // ignore anything older than this — likely an abandoned thread, not a stuck one
const MAX_CANDIDATES_PER_SWEEP = 200;

@Injectable()
export class StaleReplySweepService {
  private readonly logger = new Logger(StaleReplySweepService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly aiSettingsService: AiSettingsService,
    private readonly aiReplyProducer: AiReplyProducer,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const aiSettings = await this.aiSettingsService.get();
    if (!aiSettings.aiEnabledByDefault) {
      this.logger.log('[SWEEP] global AI toggle is off — skipping this run');
      return;
    }

    const now = Date.now();
    const staleBefore = new Date(now - STALE_AFTER_MS);
    const lookbackAfter = new Date(now - LOOKBACK_MS);

    // Same two gates as the webhook/worker's aiShouldReply check (assigned
    // to nobody, conversation-level AI still active) — the third gate there
    // (aiEnabledByDefault) is already checked once above for the whole run.
    const candidates = await this.conversationRepo.find({
      where: {
        status: ConversationStatus.AI_ACTIVE,
        assignedModeratorId: IsNull(),
        lastMessageAt: Between(lookbackAfter, staleBefore),
      },
      order: { lastMessageAt: 'ASC' },
      take: MAX_CANDIDATES_PER_SWEEP,
    });

    if (candidates.length === 0) {
      this.logger.log('[SWEEP] no AI-eligible conversations in the stale window — nothing to check');
      return;
    }

    this.logger.log(`[SWEEP] checking ${candidates.length} AI-eligible conversation(s) with no recent activity`);

    let requeued = 0;
    for (const conversation of candidates) {
      // conversation.lastMessage/lastMessageAt get overwritten with the AI's
      // own reply once one is sent successfully — so if the *actual* last
      // message row is still from the customer, nothing ever answered them.
      const lastMessage = await this.messageRepo.findOne({
        where: { conversationId: conversation.id },
        order: { createdAt: 'DESC' },
      });

      if (!lastMessage || lastMessage.senderType !== MessageSender.CUSTOMER) continue;

      this.logger.warn(
        `[SWEEP] conversation=${conversation.id} — last message is unanswered (from customer, sent ${lastMessage.createdAt.toISOString()}) — re-queuing AI reply`,
      );
      await this.aiReplyProducer.enqueue({
        conversationId: conversation.id,
        customerId: conversation.customerId,
      });
      requeued += 1;
    }

    this.logger.log(`[SWEEP] done — re-queued ${requeued}/${candidates.length} conversation(s)`);
  }
}
