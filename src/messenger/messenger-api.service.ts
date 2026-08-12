import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Thin client for the Messenger Send API (Graph API). Same shape as
// WhatsappApiService — single-Page setup for now: credentials come from env,
// not the channel_accounts row (that column stays for future multi-page support).
@Injectable()
export class MessengerApiService {
  private readonly logger = new Logger(MessengerApiService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendText(psid: string, body: string): Promise<void> {
    const accessToken = this.configService.get<string>('FB_PAGE_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!accessToken) {
      this.logger.warn('FB_PAGE_ACCESS_TOKEN not configured — skipping outbound Messenger send');
      return;
    }

    const res = await fetch(`https://graph.facebook.com/${apiVersion}/me/messages?access_token=${accessToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: body },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`Messenger send failed (${res.status}): ${errText}`);
      throw new Error(`Messenger API error: ${res.status}`);
    }
  }

  // Best-effort — requires Advanced Access for "Business Asset User Profile
  // Access" to work outside of app admins/testers. Returns undefined (never
  // throws) so a lookup failure just falls back to showing the PSID as name.
  async getUserProfile(psid: string): Promise<string | undefined> {
    const accessToken = this.configService.get<string>('FB_PAGE_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!accessToken) return undefined;

    try {
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${psid}?fields=first_name,last_name&access_token=${accessToken}`,
      );

      if (!res.ok) {
        const errText = await res.text();
        this.logger.warn(`Could not fetch Messenger profile for psid=${psid}: ${errText}`);
        return undefined;
      }

      const data = (await res.json()) as { first_name?: string; last_name?: string };
      const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
      return name || undefined;
    } catch (err) {
      this.logger.warn(`Messenger profile lookup failed for psid=${psid}: ${(err as Error).message}`);
      return undefined;
    }
  }
}
