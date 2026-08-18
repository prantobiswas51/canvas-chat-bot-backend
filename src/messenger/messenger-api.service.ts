import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Thin client for the Messenger Send API (Graph API). Each Facebook Page has
// its own access token, so callers pass the token from that Page's
// channel_accounts row — see sendText/getUserProfile below.
@Injectable()
export class MessengerApiService {
  private readonly logger = new Logger(MessengerApiService.name);

  constructor(private readonly configService: ConfigService) {}

  // accessToken should come from the sending Page's channel_accounts row
  // (each Page has its own token) — the FB_PAGE_ACCESS_TOKEN env var is only
  // a fallback for channels connected before per-row tokens existed, or
  // added without one.
  async sendText(psid: string, body: string, accessToken?: string): Promise<void> {
    const token = accessToken || this.configService.get<string>('FB_PAGE_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!token) {
      this.logger.warn('No Messenger access token (channel_accounts row or FB_PAGE_ACCESS_TOKEN) — skipping send');
      return;
    }

    const res = await fetch(`https://graph.facebook.com/${apiVersion}/me/messages?access_token=${token}`, {
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
  async getUserProfile(psid: string, accessToken?: string): Promise<string | undefined> {
    const token = accessToken || this.configService.get<string>('FB_PAGE_ACCESS_TOKEN');
    const apiVersion = this.configService.get<string>('WA_GRAPH_API_VERSION', 'v21.0');

    if (!token) return undefined;

    try {
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${psid}?fields=first_name,last_name&access_token=${token}`,
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
