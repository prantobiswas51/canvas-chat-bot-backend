import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiService } from './gemini.service';

// Speech-to-text for inbound WhatsApp/Messenger voice notes. Tries Gemini
// first (native audio understanding, no separate transcription product to
// run out of credits on) and falls back to OpenAI Whisper if Gemini isn't
// configured or the request fails for any reason — so a Gemini hiccup or a
// dry OpenAI balance doesn't silently kill voice-note handling either way.
// Independent of whichever provider is selected for chat replies in Settings.
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly geminiService: GeminiService,
  ) {}

  async transcribe(buffer: Buffer, mimeType: string, filename = 'audio'): Promise<string | undefined> {
    const geminiText = await this.geminiService.transcribeAudio(buffer, mimeType);
    if (geminiText) return geminiText;

    this.logger.warn('Gemini transcription unavailable — falling back to OpenAI Whisper');
    return this.transcribeWithWhisper(buffer, mimeType, filename);
  }

  private async transcribeWithWhisper(buffer: Buffer, mimeType: string, filename: string): Promise<string | undefined> {
    const apiKey =
      this.configService.get<string>('CHATGPT_API_KEY') || this.configService.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      this.logger.warn('CHATGPT_API_KEY not configured — voice message transcription unavailable');
      return undefined;
    }

    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filenameWithExtension(filename, mimeType));
      form.append('model', 'whisper-1');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      const data = (await res.json()) as { text?: string; error?: { message: string } };

      if (!res.ok) {
        this.logger.error(`Whisper transcription failed (${res.status}): ${JSON.stringify(data)}`);
        return undefined;
      }

      const text = data.text?.trim();
      return text || undefined;
    } catch (err) {
      this.logger.error(`Whisper transcription request failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}

// Whisper infers format from the filename's extension — WhatsApp sends ogg
// (opus), Messenger sends mp4/aac, so pick a sane extension from the mime
// type rather than hardcoding one that might not match.
const MIME_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

function filenameWithExtension(base: string, mimeType: string): string {
  const ext = MIME_EXTENSIONS[mimeType.toLowerCase()] || 'ogg';
  return `${base}.${ext}`;
}
