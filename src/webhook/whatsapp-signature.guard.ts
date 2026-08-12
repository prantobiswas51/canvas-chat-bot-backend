import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import * as crypto from 'crypto';

// Verifies Meta's X-Hub-Signature-256 header against FB_APP_SECRET, using the raw
// request body (requires `rawBody: true` in NestFactory.create — see main.ts).
// Fails open (allows the request) if the secret or rawBody aren't available, so
// local dev without FB_APP_SECRET set doesn't get blocked.
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const appSecret = this.configService.get<string>('FB_APP_SECRET');
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;

    if (!appSecret || !signatureHeader || !req.rawBody) {
      this.logger.warn('Skipping webhook signature check (FB_APP_SECRET, signature header, or rawBody missing)');
      return true;
    }

    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');

    const isValid =
      expected.length === signatureHeader.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));

    if (!isValid) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
