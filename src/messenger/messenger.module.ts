import { Module } from '@nestjs/common';
import { MessengerApiService } from './messenger-api.service';

@Module({
  providers: [MessengerApiService],
  exports: [MessengerApiService],
})
export class MessengerModule {}
