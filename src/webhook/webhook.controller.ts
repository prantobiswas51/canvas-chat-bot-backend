import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly configService: ConfigService) { }

  // Meta calls this once (GET) to verify you own the endpoint
  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    console.log('First 23 line');

    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const verifyToken = this.configService.get<string>('FB_VERIFY_TOKEN');

    this.logger.log(`mode=${mode}`);
    this.logger.log(`token=${token}`);
    this.logger.log(`verifyToken=${verifyToken}`);

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    }

    this.logger.warn('Webhook verification failed');
    return res.sendStatus(403);
  }

  // Meta calls this (POST) for every message/event
  @Post()
  @HttpCode(200)
  handleEvent(@Body() body: any) {

    console.log('Post webhook event received:');

    if (body.object === 'page') {
      for (const entry of body.entry ?? []) {
        for (const event of entry.messaging ?? []) {
          this.logger.log(JSON.stringify(event));
          // TODO: persist contact + message to DB here
        }
      }
    }
    return 'EVENT_RECEIVED';
  }
}
