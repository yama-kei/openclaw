/**
 * Voice Webhook Handler
 *
 * Terminal endpoint for voice input — NOT a chat channel like Telegram/Discord.
 * Voice terminals send raw audio and expect synthesized speech responses.
 *
 * Flow:
 * 1. Authenticate request (bearer token required)
 * 2. Decode audio_base64 and validate size
 * 3. Transcribe via STT
 * 4. Dispatch to agent
 * 5. Return text response + non-streaming TTS audio (base64)
 *
 * Security:
 * - Requires bearer token (cfg.voice?.webhookToken or OPENCLAW_VOICE_WEBHOOK_TOKEN)
 * - Raw audio size bounded to 7MB after decode
 * - Transcription only returned with X-OpenClaw-Debug header
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { textToSpeech } from "../tts/tts.js";
import { readJsonBody } from "./hooks.js";
import { dispatchToAgent, type AgentDispatchResult } from "./voice-webhook-dispatch.js";
import { transcribeAudio, type SttResult } from "./voice-webhook-stt.js";

const log = createSubsystemLogger("gateway/voice");

// Re-export for test access
export { transcribeAudio, type SttResult } from "./voice-webhook-stt.js";
export { dispatchToAgent, type AgentDispatchResult } from "./voice-webhook-dispatch.js";

// Maximum JSON body: 10MB (base64 audio + overhead)
const MAX_VOICE_BODY_BYTES = 10 * 1024 * 1024;

// Debug header to enable transcription in response
const DEBUG_HEADER = "x-openclaw-debug";

/**
 * Inbound voice request payload.
 */
export type VoiceRequest = {
  session_id: string;
  audio_base64: string;
  audio_mime?: string;
  language?: string;
};

/**
 * Voice response payload.
 */
export type VoiceResponse = {
  text: string;
  speak: boolean;
  tts_audio_base64: string | null;
  /** Only included when X-OpenClaw-Debug header is set */
  transcription?: string;
};

type VoiceValidationResult = { ok: true; value: VoiceRequest } | { ok: false; error: string };

/**
 * Validates the shape of an incoming voice webhook payload.
 */
function validateVoicePayload(payload: unknown): VoiceValidationResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "payload must be an object" };
  }

  const obj = payload as Record<string, unknown>;

  if (typeof obj.session_id !== "string") {
    return { ok: false, error: "session_id must be a string" };
  }
  const sessionId = obj.session_id.trim();
  if (!sessionId) {
    return { ok: false, error: "session_id is required" };
  }

  if (typeof obj.audio_base64 !== "string") {
    return { ok: false, error: "audio_base64 must be a string" };
  }
  const audioBase64 = obj.audio_base64;
  if (!audioBase64) {
    return { ok: false, error: "audio_base64 is required" };
  }

  const audioMime =
    typeof obj.audio_mime === "string" && obj.audio_mime.trim()
      ? obj.audio_mime.trim()
      : "audio/wav";

  const language =
    typeof obj.language === "string" && obj.language.trim() ? obj.language.trim() : undefined;

  return {
    ok: true,
    value: { session_id: sessionId, audio_base64: audioBase64, audio_mime: audioMime, language },
  };
}

/**
 * Decodes base64 audio to Buffer with error handling.
 */
function decodeAudioBase64(
  base64: string,
): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  try {
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) {
      return { ok: false, error: "audio_base64 decodes to empty buffer" };
    }
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, error: `invalid base64 encoding: ${String(err)}` };
  }
}

/**
 * Resolves the webhook authentication token.
 */
function resolveVoiceWebhookToken(cfg: OpenClawConfig): string | undefined {
  // Config takes precedence
  const configToken = (cfg as { voice?: { webhookToken?: string } }).voice?.webhookToken?.trim();
  if (configToken) {
    return configToken;
  }

  // Fall back to environment variable
  return process.env.OPENCLAW_VOICE_WEBHOOK_TOKEN?.trim() || undefined;
}

/**
 * Validates bearer token authentication.
 */
function validateAuth(
  req: IncomingMessage,
  expectedToken: string | undefined,
): { ok: true } | { ok: false; error: string } {
  // If no token configured, allow (dev mode)
  if (!expectedToken) {
    return { ok: true };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return { ok: false, error: "Authorization header required" };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, error: "Invalid authorization format (expected Bearer token)" };
  }

  const token = match[1].trim();
  if (token !== expectedToken) {
    return { ok: false, error: "Invalid token" };
  }

  return { ok: true };
}

/**
 * Sends a JSON response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function logTiming(label: string, durationMs: number): void {
  log.info(`${label} ${durationMs}ms`);
}

function constrainForVoice(text: string): string {
  if (!text) {
    return text;
  }

  let normalized = text
    .replace(/[*_`>#-]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const maxChars = 200;
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const corrections = new Map<string, string>([
    ["electrictype", "electric-type"],
    ["mouselike", "mouse-like"],
  ]);
  for (const [needle, replacement] of corrections) {
    normalized = normalized.replace(new RegExp(needle, "gi"), replacement);
  }

  const sentences = normalized.split(/(?<=[.!?。！？])\s+/);
  if (sentences.length > 1) {
    let acc = "";
    for (const sentence of sentences) {
      if (`${acc} ${sentence}`.trim().length > maxChars) {
        break;
      }
      acc = acc ? `${acc} ${sentence}` : sentence;
    }
    if (acc) {
      return acc.trim();
    }
  }

  return normalized.slice(0, maxChars).trim();
}

/**
 * Checks if debug mode is enabled via header.
 */
function isDebugEnabled(req: IncomingMessage): boolean {
  const header = req.headers[DEBUG_HEADER];
  return header === "1" || header === "true";
}

export type VoiceWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export type VoiceWebhookHandlerOptions = {
  basePath?: string;
  cfg: OpenClawConfig;
  sttProvider?: string;
  sttModel?: string;
};

/**
 * Creates the voice webhook HTTP handler.
 *
 * TTS is synchronous and non-streaming (tts_audio_base64 is returned when available).
 */
export function createVoiceWebhookHandler(opts: VoiceWebhookHandlerOptions): VoiceWebhookHandler {
  const basePath = opts.basePath ?? "/webhooks/voice";
  const { cfg } = opts;
  const sttProvider = opts.sttProvider;
  const sttModel = opts.sttModel;

  // Resolve token once at handler creation
  const webhookToken = resolveVoiceWebhookToken(cfg);

  return async (req, res) => {
    // Route matching
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== basePath) {
      return false;
    }

    const requestStart = Date.now();
    try {
      // Method check
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Method Not Allowed");
        return true;
      }

      // Authentication
      const authResult = validateAuth(req, webhookToken);
      if (!authResult.ok) {
        sendJson(res, 401, { error: authResult.error });
        return true;
      }

      // Read JSON body
      const body = await readJsonBody(req, MAX_VOICE_BODY_BYTES);
      if (!body.ok) {
        const status = body.error === "payload too large" ? 413 : 400;
        sendJson(res, status, { error: body.error });
        return true;
      }

      // Validate payload
      const validated = validateVoicePayload(body.value);
      if (!validated.ok) {
        sendJson(res, 400, { error: validated.error });
        return true;
      }

      const { session_id, audio_base64, audio_mime, language } = validated.value;
      const debugMode = isDebugEnabled(req);

      // Decode base64 audio
      const decodeStart = Date.now();
      const decoded = decodeAudioBase64(audio_base64);
      logTiming("voice.timing.decode", Date.now() - decodeStart);
      if (!decoded.ok) {
        sendJson(res, 400, { error: decoded.error });
        return true;
      }

      // STT: Transcribe audio to text
      const sttStart = Date.now();
      const sttResult = await transcribeAudio({
        buffer: decoded.buffer,
        mime: audio_mime ?? "audio/wav",
        language,
        cfg,
        provider: sttProvider,
        model: sttModel,
      });
      logTiming("voice.timing.stt", Date.now() - sttStart);

      if (!sttResult.ok) {
        // Map retryable errors to 503, others to 400
        const status = sttResult.retryable ? 503 : 400;
        sendJson(res, status, { error: sttResult.error });
        return true;
      }

      const transcribedText = sttResult.text;

      // Agent dispatch
      const agentStart = Date.now();
      const agentResult = await dispatchToAgent({
        text: transcribedText,
        sessionId: session_id,
        cfg,
      });
      logTiming("voice.timing.agent", Date.now() - agentStart);

      if (!agentResult.ok) {
        const response: VoiceResponse = {
          text: agentResult.error,
          speak: false,
          tts_audio_base64: null,
          ...(debugMode ? { transcription: transcribedText } : {}),
        };
        sendJson(res, 500, response);
        return true;
      }

      const constrainedText = constrainForVoice(agentResult.text);
      let ttsAudioBase64: string | null = null;
      try {
        // TODO: Non-streaming TTS only; streaming/interruptible playback can be added later.
        const ttsResult = await textToSpeech({ text: constrainedText, cfg });
        if (ttsResult.success && ttsResult.audioPath) {
          const audioBuffer = readFileSync(ttsResult.audioPath);
          ttsAudioBase64 = audioBuffer.toString("base64");
        } else if (!ttsResult.success) {
          log.warn(`voice.tts failed: ${ttsResult.error ?? "unknown error"}`);
        }
      } catch (err) {
        log.warn(`voice.tts failed: ${String(err)}`);
      }

      const response: VoiceResponse = {
        text: constrainedText,
        speak: true,
        tts_audio_base64: ttsAudioBase64,
        ...(debugMode ? { transcription: transcribedText } : {}),
      };

      sendJson(res, 200, response);
      return true;
    } finally {
      logTiming("voice.timing.total", Date.now() - requestStart);
    }
  };
}
