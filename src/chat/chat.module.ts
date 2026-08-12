import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { Customer } from './entities/customer.entity';
import { ChannelAccount } from './entities/channel-account.entity';
import { CustomerChannelIdentity } from './entities/customer-channel-identity.entity';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessengerModule } from '../messenger/messenger.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, Customer, ChannelAccount, CustomerChannelIdentity]),
    WhatsappModule,
    MessengerModule,
    RealtimeModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
