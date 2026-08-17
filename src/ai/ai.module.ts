import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeminiService } from './gemini.service';
import { OpenAiService } from './openai.service';
import { ClaudeService } from './claude.service';
import { TranscriptionService } from './transcription.service';
import { AiSettings } from './entities/ai-settings.entity';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsController } from './ai-settings.controller';

// Provider selection is dynamic per-message (see webhook.service.ts, which
// reads AiSettings.aiProvider on every inbound message and picks whichever
// of these three services to call) rather than resolved once at boot, so
// the Settings page dropdown takes effect immediately without a restart.
@Module({
  imports: [TypeOrmModule.forFeature([AiSettings])],
  controllers: [AiSettingsController],
  providers: [GeminiService, OpenAiService, ClaudeService, TranscriptionService, AiSettingsService],
  exports: [GeminiService, OpenAiService, ClaudeService, TranscriptionService, AiSettingsService],
})
export class AiModule {}
