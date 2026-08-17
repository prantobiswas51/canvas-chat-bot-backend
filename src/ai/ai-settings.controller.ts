import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';

@Controller('ai-settings')
export class AiSettingsController {
  constructor(private readonly aiSettingsService: AiSettingsService) {}

  @Get()
  get() {
    return this.aiSettingsService.get();
  }

  @Patch()
  update(@Body() dto: UpdateAiSettingsDto) {
    return this.aiSettingsService.update(dto);
  }
}
