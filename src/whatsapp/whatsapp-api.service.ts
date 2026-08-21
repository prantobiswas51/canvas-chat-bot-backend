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

  // WhatsApp has no "send this base64/raw image inline" option — every
  // outbound image has to become a media ID first (2-step: upload the bytes,
  // then reference the ID in a message) or a public URL, and a moderator's
  // local upload has neither yet. Caption is inline on the image message
  // itself (unlike Messenger, which needs a separate text bubble).
  async sendImage(to: string, base64Data: string, mimeType: string, caption?: string): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WA_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WA_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN not configured — skipping outbound WhatsApp image send');
      return;
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([buffer], { type: mimeType }), 'image');

    const uploadRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      this.logger.error(`WhatsApp media upload failed (${uploadRes.status}): ${errText}`);
      throw new Error(`WhatsApp media upload error: ${uploadRes.status}`);
    }

    const { id: mediaId } = (await uploadRes.json()) as { id: string };

    const sendRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { id: mediaId, ...(caption ? { caption } : {}) },
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      this.logger.error(`WhatsApp image send failed (${sendRes.status}): ${errText}`);
      throw new Error(`WhatsApp API error: ${sendRes.status}`);
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
