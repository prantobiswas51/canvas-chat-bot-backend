import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Thin client for the WhatsApp Cloud API (Graph API). Uses Node's built-in fetch —
// no extra HTTP dependency needed. Single-number setup for now: credentials come
// from env, not the channel_accounts row (that column stays for future multi-number support).
@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendText(to: string, body: string): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WA_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WA_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN not configured — skipping outbound WhatsApp send');
      return;
    }

    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`WhatsApp send failed (${res.status}): ${errText}`);
      throw new Error(`WhatsApp API error: ${res.status}`);
    }
  }
}
