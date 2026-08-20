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
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AiModule } from '../ai/ai.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChannelAccount, Customer, CustomerChannelIdentity, Conversation, Message]),
    RealtimeModule,
    MessengerModule,
    WhatsappModule,
    AiModule,
    QueueModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WhatsappSignatureGuard],
})
export class WebhookModule {}
