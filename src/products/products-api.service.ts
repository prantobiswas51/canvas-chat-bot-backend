import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CachedToken {
  idToken: string;
  expiresAt: number; // epoch ms
}

interface FirebaseRefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string; // seconds, as a string per Firebase's API
}

// Thin client for the store's own product catalog API (a separate backend,
// not Meta/Gemini). Only a search-by-query lookup for now — the AI tool
// calls this and hands the raw JSON straight back to Gemini to describe,
// so no field-by-field parsing is needed on our side.
//
// Auth: the catalog API takes a Firebase ID token, which expires ~hourly.
// Rather than requiring a human to paste a fresh one into .env every hour,
// this service auto-refreshes it in the background using a Firebase
// refresh token (PRODUCTS_API_REFRESH_TOKEN) via Google's securetoken
// endpoint — the same mechanism the Firebase JS SDK uses internally.
// If FIREBASE_API_KEY / PRODUCTS_API_REFRESH_TOKEN aren't configured, it
// falls back to the static PRODUCTS_API_TOKEN (manual-refresh mode).
@Injectable()
export class ProductsApiService {
  private readonly logger = new Logger(ProductsApiService.name);
  private cached: CachedToken | null = null;
  // Firebase rotates the refresh token on each use — keep the latest one
  // in memory so subsequent refreshes within this process use it. Falls
  // back to the .env value on restart.
  private currentRefreshToken: string | null = null;

  constructor(private readonly configService: ConfigService) {}

  async search(query: string): Promise<unknown> {
    const baseUrl = this.configService.get<string>(
      'PRODUCTS_API_BASE_URL',
      'https://dev.canvasdhaka.com/api/admin/products',
    );

    const token = await this.getAccessToken();
    if (!token) {
      return { error: 'Product search is not configured yet.' };
    }

    const doRequest = (bearer: string) =>
      fetch(`${baseUrl}?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

    try {
      let res = await doRequest(token);

      if (res.status === 401 || res.status === 403) {
        // Token might've expired right between our cache check and this
        // request — force one refresh + retry before giving up.
        this.logger.warn(`Products API auth failed (${res.status}) — forcing a token refresh and retrying once`);
        this.cached = null;
        const refreshed = await this.getAccessToken(true);
        if (!refreshed) {
          return { error: 'Product lookup is temporarily unavailable — ask a human teammate to check.' };
        }
        res = await doRequest(refreshed);
      }

      if (res.status === 401 || res.status === 403) {
        this.logger.warn(
          `Products API auth still failing (${res.status}) after refresh — PRODUCTS_API_REFRESH_TOKEN may be invalid/revoked`,
        );
        return { error: 'Product lookup is temporarily unavailable — ask a human teammate to check.' };
      }

      if (!res.ok) {
        const errText = await res.text();
        this.logger.warn(`Products API search failed (${res.status}): ${errText}`);
        return { error: `Product search failed (status ${res.status}).` };
      }

      return await res.json();
    } catch (err) {
      this.logger.warn(`Products API request failed: ${(err as Error).message}`);
      return { error: 'Product search is temporarily unavailable.' };
    }
  }

  // Returns a live Firebase ID token, refreshing it first if it's missing,
  // expired, or force=true. Falls back to the static PRODUCTS_API_TOKEN if
  // refresh isn't configured.
  private async getAccessToken(force = false): Promise<string | null> {
    const apiKey = this.configService.get<string>('FIREBASE_API_KEY');
    const refreshToken = this.currentRefreshToken ?? this.configService.get<string>('PRODUCTS_API_REFRESH_TOKEN');

    if (!apiKey || !refreshToken) {
      // Auto-refresh not configured — fall back to the manually-pasted token.
      const staticToken = this.configService.get<string>('PRODUCTS_API_TOKEN');
      if (!staticToken) {
        this.logger.warn(
          'Neither FIREBASE_API_KEY/PRODUCTS_API_REFRESH_TOKEN nor PRODUCTS_API_TOKEN are configured — cannot search products',
        );
      }
      return staticToken ?? null;
    }

    const now = Date.now();
    if (!force && this.cached && now < this.cached.expiresAt - 60_000) {
      return this.cached.idToken;
    }

    try {
      const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.warn(`Firebase token refresh failed (${res.status}): ${errText}`);
        return this.cached?.idToken ?? null;
      }

      const data = (await res.json()) as FirebaseRefreshResponse;
      this.currentRefreshToken = data.refresh_token;
      this.cached = {
        idToken: data.id_token,
        expiresAt: now + Number(data.expires_in) * 1000,
      };
      this.logger.log('Refreshed Products API token via Firebase');
      return this.cached.idToken;
    } catch (err) {
      this.logger.warn(`Firebase token refresh request failed: ${(err as Error).message}`);
      return this.cached?.idToken ?? null;
    }
  }
}
