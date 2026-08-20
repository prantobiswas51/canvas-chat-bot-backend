import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface AiReplyJobData {
  conversationId: string;
  customerId: string;
}

// 3 attempts with exponential backoff (5s, 10s, 20s between tries). This
// used to be a single attempt — a naive retry loop that just re-hits the
// same overloaded/rate-limited model amplifies the problem. Two things
// changed that: (1) GeminiService now hops across a fallback model chain
// *within* a single attempt (see gemini.service.ts), so a job only reaches
// this retry layer once every model has already failed — i.e. a real,
// broad outage, not one busy model. (2) a genuine 503 "high demand" is a
// transient Google-side capacity blip, not a self-inflicted spend/rate
// ceiling — waiting a few seconds and trying again (on top of the model
// hop) is exactly the right response. Still bounded at 3 so a real 429
// spend-limit outage doesn't get hammered indefinitely.
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

@Injectable()
export class AiReplyProducer {
  private readonly logger = new Logger(AiReplyProducer.name);

  // How long to wait after the customer's *last* message before actually
  // calling Gemini. Someone typing "how are" then "you" a second later is
  // one thought split across two webhook deliveries — replying to the first
  // half alone wastes a call and gives a nonsense answer. Every new message
  // in the same conversation pushes this timer back out (see enqueue()
  // below), so a whole burst collapses into a single AI call once things
  // go quiet, and AiReplyService's history fetch naturally picks up every
  // message that arrived during the wait — no separate batching logic needed.
  private readonly debounceMs: number;

  constructor(
    @InjectQueue('ai-reply') private readonly queue: Queue<AiReplyJobData>,
    configService: ConfigService,
  ) {
    this.debounceMs = configService.get<number>('AI_REPLY_DEBOUNCE_MS', 25000);
  }

  // One BullMQ job per conversation, keyed by a deterministic jobId — a
  // second message before the first's delay elapses doesn't add a second
  // job, it just reschedules the same one further out (changeDelay).
  async enqueue(data: AiReplyJobData): Promise<void> {
    const jobId = `ai-reply-${data.conversationId}`;
    const existing = await this.queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();

      if (state === 'delayed') {
        // More messages arrived during the quiet-period wait — reset the
        // clock instead of letting it fire mid-burst.
        await existing.updateData(data);
        await existing.changeDelay(this.debounceMs);
        this.logger.log(
          `[DEBOUNCE] conversation=${data.conversationId} — more messages arrived, pushed reply out another ${this.debounceMs / 1000}s`,
        );
        return;
      }

      if (state === 'waiting' || state === 'active') {
        // Already past the debounce wait and running (or about to) for the
        // previous batch — let it finish rather than trying to interrupt
        // it; this message starts its own fresh debounce window instead.
        this.logger.log(
          `[DEBOUNCE] conversation=${data.conversationId} — previous batch already ${state}, starting a new debounce window`,
        );
        await this.queue.add('generate-reply', data, { ...JOB_OPTS, delay: this.debounceMs });
        return;
      }

      // completed/failed — stale record under the same jobId, clear it so
      // the deterministic jobId below can be reused.
      await existing.remove().catch(() => undefined);
    }

    await this.queue.add('generate-reply', data, { ...JOB_OPTS, jobId, delay: this.debounceMs });
    this.logger.log(
      `[DEBOUNCE] conversation=${data.conversationId} — new batch started, will reply in ${this.debounceMs / 1000}s if quiet`,
    );
  }
}
