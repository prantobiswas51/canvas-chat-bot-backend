import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Customer } from '../chat/entities/customer.entity';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiReplyService } from '../ai/ai-reply.service';
import { RetryableAiError } from '../ai/retryable-ai-error';
import { AiReplyJobData } from './ai-reply.producer';

// Decorator options are evaluated once at class-definition time (module
// import time), before Nest's DI/ConfigService exists — read process.env
// directly here, same as main.ts's own top-level env reads. Safe because
// main.ts's `import 'dotenv/config'` (its literal first line) always
// finishes before this file — or anything else in the app — gets imported.
const CONCURRENCY = Number(process.env.AI_WORKER_CONCURRENCY) || 3;

// The "AI Worker" box in the pipeline diagram — pulls jobs off the
// 'ai-reply' queue with a capped concurrency (AI_WORKER_CONCURRENCY, default
// 3) instead of letting every inbound webhook fire its own AI call
// immediately. This is what actually protects against bursts: even if 50
// messages land in the same second, at most N AI calls run at once — the
// rest wait their turn in Redis instead of piling onto the provider.
@Injectable()
@Processor('ai-reply', {
  concurrency: CONCURRENCY,
})
export class AiReplyProcessor extends WorkerHost {
  private readonly logger = new Logger(AiReplyProcessor.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    private readonly aiSettingsService: AiSettingsService,
    private readonly aiReplyService: AiReplyService,
  ) {
    super();
  }

  async process(job: Job<AiReplyJobData>): Promise<void> {
    const { conversationId, customerId } = job.data;
    const tag = `job=${job.id} conversation=${conversationId}`;

    this.logger.log(`[WORKER STEP 1/4] ${tag} — picked up job (attempt ${job.attemptsMade + 1})`);

    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    const customer = await this.customerRepo.findOne({ where: { id: customerId } });
    if (!conversation || !customer) {
      this.logger.warn(`[WORKER STEP 1/4] ${tag} — skipped: conversation or customer no longer exists`);
      return;
    }
    this.logger.log(`[WORKER STEP 1/4] ${tag} — loaded conversation + customer`);

    // Re-check the same three gates as WebhookService right before actually
    // calling the AI — a moderator may have taken the chat over, or AI been
    // globally disabled, while this job was waiting in the queue.
    this.logger.log(`[WORKER STEP 2/4] ${tag} — re-checking AI-should-reply gate`);
    const aiSettings = await this.aiSettingsService.get();
    const aiShouldReply =
      aiSettings.aiEnabledByDefault &&
      conversation.status === ConversationStatus.AI_ACTIVE &&
      !conversation.assignedModeratorId;

    if (!aiShouldReply) {
      this.logger.log(`[WORKER STEP 2/4] ${tag} — skipped: no longer eligible for an AI reply`);
      return;
    }
    this.logger.log(`[WORKER STEP 2/4] ${tag} — gate passed, proceeding`);

    this.logger.log(
      `[WORKER STEP 3/4] ${tag} — handing off to AiReplyService.generateAndSendAiReply (provider="${aiSettings.aiProvider}")`,
    );
    // Lets RetryableAiError propagate — BullMQ catches whatever this promise
    // rejects with and retries the job with backoff, up to JOB_OPTS.attempts
    // (see ai-reply.producer.ts). GeminiService already tries a fallback
    // model chain before ever throwing, so a job-level retry only happens
    // once every model has failed transiently — OpenAI has no such chain
    // yet, so a job-level retry is its only recovery from a transient error.
    await this.aiReplyService.generateAndSendAiReply(
      conversation,
      customer,
      aiSettings.customInstructions,
      aiSettings.aiProvider,
    );
    this.logger.log(`[WORKER STEP 4/4] ${tag} — job finished successfully`);
  }

  // Fires once a job has exhausted every attempt (BullMQ only emits this
  // after the *final* failed attempt — intermediate retries just get
  // requeued for their backoff delay without hitting this handler), so this
  // is genuinely "we gave up" — not "one attempt failed."
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AiReplyJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const attempts = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 1;
    const reason = error instanceof RetryableAiError ? 'provider rate/spend limit or outage' : error.message;
    this.logger.error(
      `AI reply job FAILED — conversation=${job.data.conversationId} attempts=${attempts}/${maxAttempts} reason="${reason}"`,
    );

    if (attempts >= maxAttempts) {
      await this.aiReplyService.notifyReplyFailed(job.data.conversationId, reason).catch((err) => {
        this.logger.error(`Failed to post AI-failure system message: ${(err as Error).message}`);
      });
    }
  }
}
