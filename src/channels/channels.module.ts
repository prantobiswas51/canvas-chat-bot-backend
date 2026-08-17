import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelAccount } from '../chat/entities/channel-account.entity';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [TypeOrmModule.forFeature([ChannelAccount])],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}
