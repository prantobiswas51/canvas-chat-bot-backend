import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelAccount } from '../chat/entities/channel-account.entity';
import { CreateChannelDto } from './dto/create-channel.dto';

@Injectable()
export class ChannelsService {
  constructor(
    @InjectRepository(ChannelAccount)
    private readonly channelAccountRepo: Repository<ChannelAccount>,
  ) {}

  async list(): Promise<ChannelAccount[]> {
    // accessToken is select:false on the entity, so it never comes back here.
    return this.channelAccountRepo.find({ order: { createdAt: 'DESC' } });
  }

  // Upsert by (channel, externalAccountId) — matches the same idempotent
  // pattern as the setup:whatsapp-channel / setup:messenger-channel scripts,
  // so re-submitting the form to update a token/name is safe.
  async create(dto: CreateChannelDto): Promise<ChannelAccount> {
    const existing = await this.channelAccountRepo.findOne({
      where: { channel: dto.channel, externalAccountId: dto.externalAccountId },
    });

    if (existing) {
      existing.displayName = dto.displayName;
      if (dto.accessToken) existing.accessToken = dto.accessToken;
      // @Exclude() on ChannelAccount.accessToken strips it from the HTTP
      // response automatically via the global ClassSerializerInterceptor.
      return this.channelAccountRepo.save(existing);
    }

    return this.channelAccountRepo.save(
      this.channelAccountRepo.create({
        channel: dto.channel,
        externalAccountId: dto.externalAccountId,
        displayName: dto.displayName,
        accessToken: dto.accessToken,
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const result = await this.channelAccountRepo.delete(id);
    if (!result.affected) throw new NotFoundException('Channel not found');
  }
}
