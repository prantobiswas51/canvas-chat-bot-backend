import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { Customer } from '../chat/entities/customer.entity';
import { AiModule } from '../ai/ai.module';
import { AiReplyProducer } from './ai-reply.producer';
import { AiReplyProcessor } from './ai-reply.processor';

// The "Redis / Queue" + "AI Worker" boxes in the pipeline diagram. Webhook
// ingestion (WebhookService) only ever talks to AiReplyProducer — it never
// imports GeminiService/OpenAiService/ClaudeService or calls the AI
// directly anymore. This is what lets the webhook HTTP handler ack Meta
// immediately (message saved + job enqueued, both fast) instead of blocking
// on however long the LLM round-trip takes.
@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    BullModule.registerQueue({ name: 'ai-reply' }),
    TypeOrmModule.forFeature([Conversation, Customer]),
    AiModule,
  ],
  providers: [AiReplyProducer, AiReplyProcessor],
  exports: [AiReplyProducer],
})
export class QueueModule {}
