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

  // Inbound media (images, docs, etc.) only comes with a media ID, not a
  // usable URL — the Cloud API's own download URL is short-lived (~5 min)
  // and requires the access token to fetch, so we download it immediately
  // and hand back base64 to embed directly rather than trying to re-host it.
  async fetchMedia(mediaId: string): Promise<{ base64: string; mimeType: string } | undefined> {
    const accessToken = this.configService.get<string>('WA_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!accessToken) {
      this.logger.warn('WA_ACCESS_TOKEN not configured — skipping inbound media download');
      return undefined;
    }

    try {
      const lookupRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!lookupRes.ok) {
        this.logger.warn(`WhatsApp media lookup failed (${lookupRes.status}): ${await lookupRes.text()}`);
        return undefined;
      }

      const { url, mime_type: mimeType } = (await lookupRes.json()) as { url?: string; mime_type?: string };
      if (!url) return undefined;

      const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!fileRes.ok) {
        this.logger.warn(`WhatsApp media download failed (${fileRes.status})`);
        return undefined;
      }

      const buffer = Buffer.from(await fileRes.arrayBuffer());
      return { base64: buffer.toString('base64'), mimeType: mimeType || 'application/octet-stream' };
    } catch (err) {
      this.logger.warn(`WhatsApp media fetch failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}
