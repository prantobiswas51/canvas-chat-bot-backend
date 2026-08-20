import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import type { AiProviderName } from '../entities/ai-settings.entity';

const AI_PROVIDERS: AiProviderName[] = ['gemini'];

export class UpdateAiSettingsDto {
  @IsOptional()
  @IsString()
  customInstructions?: string;

  @IsOptional()
  @IsBoolean()
  aiEnabledByDefault?: boolean;

  @IsOptional()
  @IsIn(AI_PROVIDERS)
  aiProvider?: AiProviderName;
}
