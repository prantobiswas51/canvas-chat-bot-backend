import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiSettings, AiProviderName } from './entities/ai-settings.entity';

const SETTINGS_ID = 'default';

@Injectable()
export class AiSettingsService {
  constructor(
    @InjectRepository(AiSettings)
    private readonly aiSettingsRepo: Repository<AiSettings>,
  ) {}

  async get(): Promise<AiSettings> {
    const existing = await this.aiSettingsRepo.findOne({ where: { id: SETTINGS_ID } });
    return (
      existing ?? {
        id: SETTINGS_ID,
        customInstructions: undefined,
        aiEnabledByDefault: true,
        // Gemini-only right now — OpenAI/Claude removed while debugging.
        aiProvider: 'gemini' as AiProviderName,
        updatedAt: new Date(),
      }
    );
  }

  async update(
    patch: Partial<Pick<AiSettings, 'customInstructions' | 'aiEnabledByDefault' | 'aiProvider'>>,
  ): Promise<AiSettings> {
    const existing = await this.aiSettingsRepo.findOne({ where: { id: SETTINGS_ID } });
    const entity = existing ?? this.aiSettingsRepo.create({ id: SETTINGS_ID });
    if (patch.customInstructions !== undefined) entity.customInstructions = patch.customInstructions;
    if (patch.aiEnabledByDefault !== undefined) entity.aiEnabledByDefault = patch.aiEnabledByDefault;
    if (patch.aiProvider !== undefined) entity.aiProvider = patch.aiProvider;
    return this.aiSettingsRepo.save(entity);
  }
}
