import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessengerModule } from '../messenger/messenger.module';
import { DispatchService } from './dispatch.service';

@Module({
  imports: [TypeOrmModule.forFeature([CustomerChannelIdentity]), WhatsappModule, MessengerModule],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
