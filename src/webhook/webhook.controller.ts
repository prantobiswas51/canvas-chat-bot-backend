import { Body, Controller, Get, HttpCode, Logger, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { WebhookService } from './webhook.service';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';
import { Public } from '../auth/decorators/public.decorator';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
  ) {}

  // Meta calls this once (GET) to verify you own the endpoint
  @Public()
  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const verifyToken = this.configService.get<string>('FB_VERIFY_TOKEN');

    this.logger.log(`Verify request — mode=${mode}`);

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verified');
      res.status(200).send(challenge);
      return;
    }

    this.logger.warn('Webhook verification failed');
    res.sendStatus(403);
  }

  // Meta calls this (POST) for every message/event
  @Public()
  @Post()
  @HttpCode(200)
  @UseGuards(WhatsappSignatureGuard)
  async handleEvent(@Body() body: any) {
    this.logger.log(`Incoming webhook — object=${body?.object}`);

    if (body.object === 'whatsapp_business_account') {
      await this.webhookService.handleWhatsappEvent(body);
    } else if (body.object === 'page') {
      await this.webhookService.handleMessengerEvent(body);
    }

    return 'EVENT_RECEIVED';
  }
}
