import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeminiService } from './gemini.service';
import { OpenAiService } from './openai.service';
import { ClaudeService } from './claude.service';
import { TranscriptionService } from './transcription.service';
import { AiReplyService } from './ai-reply.service';
import { AiSettings } from './entities/ai-settings.entity';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsController } from './ai-settings.controller';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { RealtimeModule } from '../realtime/realtime.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { ProductsModule } from '../products/products.module';
import { OrdersModule } from '../orders/orders.module';

// Provider selection is dynamic per-message (see webhook.service.ts, which
// reads AiSettings.aiProvider on every inbound message and picks whichever
// of these three services to call) rather than resolved once at boot, so
// the Settings page dropdown takes effect immediately without a restart.
@Module({
  imports: [
    TypeOrmModule.forFeature([AiSettings, Conversation, Message]),
    RealtimeModule,
    DispatchModule,
    ProductsModule,
    OrdersModule,
  ],
  controllers: [AiSettingsController],
  providers: [GeminiService, OpenAiService, ClaudeService, TranscriptionService, AiSettingsService, AiReplyService],
  exports: [GeminiService, OpenAiService, ClaudeService, TranscriptionService, AiSettingsService, AiReplyService],
})
export class AiModule {}
