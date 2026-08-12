import { Module } from '@nestjs/common';
import { WhatsappApiService } from './whatsapp-api.service';

@Module({
  providers: [WhatsappApiService],
  exports: [WhatsappApiService],
})
export class WhatsappModule {}
