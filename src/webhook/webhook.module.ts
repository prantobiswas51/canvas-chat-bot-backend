import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';
import { ChannelAccount } from '../chat/entities/channel-account.entity';
import { Customer } from '../chat/entities/customer.entity';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessengerModule } from '../messenger/messenger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelAccount, Customer, CustomerChannelIdentity, Conversation, Message]),
    RealtimeModule,
    MessengerModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WhatsappSignatureGuard],
})
export class WebhookModule {}
