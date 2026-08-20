import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface AiReplyJobData {
  conversationId: string;
  customerId: string;
}

// 5 attempts total: the initial try + 4 retries, exponential backoff
// starting at 5s (5s, 10s, 20s, 40s) — gives a rate/spend-limited provider
// roughly a minute and a half to recover before the job is finally marked
// failed (see AiReplyProcessor's onFailed handler for what happens then).
const JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

@Injectable()
export class AiReplyProducer {
  private readonly logger = new Logger(AiReplyProducer.name);

  constructor(@InjectQueue('ai-reply') private readonly queue: Queue<AiReplyJobData>) {}

  async enqueue(data: AiReplyJobData): Promise<void> {
    await this.queue.add('generate-reply', data, JOB_OPTS);
    this.logger.log(`Queued AI reply job — conversation=${data.conversationId}`);
  }
}
