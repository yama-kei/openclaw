/**
 * Voice Webhook STT (Speech-to-Text) Module
 *
 * Internal helpers for transcribing audio via OpenAI-compatible STT APIs.
 * Separated from voice-webhook.ts for maintainability and smaller diffs.
 */

import type { OpenClawConfig } from "../config/config.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { DEFAULT_TIMEOUT_SECONDS } from "../media-understanding/defaults.js";
import { transcribeOpenAiCompatibleAudio } from "../media-understanding/providers/openai/audio.js";

// Default STT provider and model
const DEFAULT_STT_PROVIDER = "openai";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";

// STT-specific timeout (shorter than default audio timeout for responsiveness)
const STT_TIMEOUT_MS = 20_000;

// Maximum raw audio size after base64 decode (7MB to account for overhead)
const MAX_AUDIO_BYTES = 7 * 1024 * 1024;

/**
 * STT result type.
 */
export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Transcribes audio buffer to text using configured STT provider.
 *
 * Error handling:
 * - 429/503 from upstream → retryable: true (client should retry)
 * - Invalid audio/decode errors → retryable: false (client error)
 * - Timeout → retryable: true (transient)
 */
export async function transcribeAudio(params: {
  buffer: Buffer;
  mime: string;
  language?: string;
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
}): Promise<SttResult> {
  const { buffer, mime, language, cfg } = params;
  const provider = params.provider ?? DEFAULT_STT_PROVIDER;
  const model = params.model ?? DEFAULT_STT_MODEL;

  // Enforce raw audio size limit (fail fast before STT call)
  if (buffer.length > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      error: `Audio too large: ${buffer.length} bytes exceeds ${MAX_AUDIO_BYTES} byte limit`,
      retryable: false,
    };
  }

  // Validate buffer is not empty
  if (buffer.length === 0) {
    return { ok: false, error: "Audio buffer is empty", retryable: false };
  }

  try {
    // Resolve API key for the STT provider
    const auth = await resolveApiKeyForProvider({ provider, cfg });
    if (!auth.apiKey) {
      return {
        ok: false,
        error: `No API key found for STT provider "${provider}"`,
        retryable: false,
      };
    }

    // Call the transcription API with explicit timeout
    const timeoutMs = Math.min(STT_TIMEOUT_MS, DEFAULT_TIMEOUT_SECONDS.audio * 1000);
    const result = await transcribeOpenAiCompatibleAudio({
      buffer,
      fileName: "voice-input.wav",
      mime,
      apiKey: auth.apiKey,
      model,
      language,
      timeoutMs,
    });

    if (!result.text) {
      return { ok: false, error: "STT returned empty transcription", retryable: false };
    }

    return { ok: true, text: result.text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Map upstream errors to retryable/non-retryable
    const isRetryable = isRetryableError(err);

    return {
      ok: false,
      error: `STT failed: ${message}`,
      retryable: isRetryable,
    };
  }
}

/**
 * Determines if an STT error is retryable (429, 503, timeout).
 */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const msg = err.message.toLowerCase();

  // Rate limit or overloaded
  if (msg.includes("429") || msg.includes("rate limit")) {
    return true;
  }
  if (msg.includes("503") || msg.includes("service unavailable")) {
    return true;
  }

  // Timeout
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return true;
  }
  if (msg.includes("econnreset") || msg.includes("socket hang up")) {
    return true;
  }

  return false;
}
