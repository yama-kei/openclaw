/**
 * Voice Webhook Handler (Stub)
 *
 * This is a terminal endpoint for voice input — NOT a chat channel like Telegram/Discord.
 * Voice terminals send raw audio and expect synthesized speech responses.
 *
 * Current implementation:
 * - Validates request shape only
 * - Returns a placeholder response
 * - Does NOT decode audio, invoke STT/TTS, or call the agent
 *
 * Future work (marked with TODO):
 * - STT: Decode audio_base64 and transcribe to text
 * - Agent: Send transcribed text to agent for processing
 * - TTS: Synthesize agent response to audio and return tts_audio_base64
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "./hooks.js";

// Maximum audio payload: 10MB base64 (approx. 7.5MB raw audio)
const MAX_VOICE_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Inbound voice request payload.
 */
export type VoiceRequest = {
  /** Unique session identifier for continuity across requests */
  session_id: string;
  /** Base64-encoded audio data (format TBD: wav, opus, etc.) */
  audio_base64: string;
};

/**
 * Voice response payload.
 */
export type VoiceResponse = {
  /** Transcribed or generated text response */
  text: string;
  /** Whether the response should be spoken */
  speak: boolean;
  /** Base64-encoded TTS audio, or null if not yet implemented */
  tts_audio_base64: string | null;
};

/**
 * Validation result for voice requests.
 */
type VoiceValidationResult = { ok: true; value: VoiceRequest } | { ok: false; error: string };

/**
 * Validates the shape of an incoming voice webhook payload.
 * Does NOT validate audio content (decoding is deferred to STT phase).
 */
function validateVoicePayload(payload: unknown): VoiceValidationResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "payload must be an object" };
  }

  const obj = payload as Record<string, unknown>;

  // Validate session_id
  if (typeof obj.session_id !== "string") {
    return { ok: false, error: "session_id must be a string" };
  }
  const sessionId = obj.session_id.trim();
  if (!sessionId) {
    return { ok: false, error: "session_id is required" };
  }

  // Validate audio_base64
  if (typeof obj.audio_base64 !== "string") {
    return { ok: false, error: "audio_base64 must be a string" };
  }
  const audioBase64 = obj.audio_base64;
  if (!audioBase64) {
    return { ok: false, error: "audio_base64 is required" };
  }

  // TODO: When STT is implemented, validate base64 format here
  // For now, accept any non-empty string

  return {
    ok: true,
    value: {
      session_id: sessionId,
      audio_base64: audioBase64,
    },
  };
}

/**
 * Sends a JSON response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export type VoiceWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Creates the voice webhook HTTP handler.
 *
 * The handler is intentionally minimal:
 * - Matches POST /webhooks/voice
 * - Validates payload shape
 * - Returns a stub response
 *
 * Agent integration and STT/TTS are NOT implemented here.
 *
 * @param opts.basePath - Base path for the webhook (default: "/webhooks/voice")
 */
export function createVoiceWebhookHandler(opts?: { basePath?: string }): VoiceWebhookHandler {
  const basePath = opts?.basePath ?? "/webhooks/voice";

  return async (req, res) => {
    // Check path match
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (url.pathname !== basePath) {
      return false; // Not our route
    }

    // Only POST allowed
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    // Read JSON body
    const body = await readJsonBody(req, MAX_VOICE_BODY_BYTES);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { error: body.error });
      return true;
    }

    // Validate payload shape
    const validated = validateVoicePayload(body.value);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return true;
    }

    // TODO: STT will be inserted here
    // const transcribedText = await transcribeAudio(validated.value.audio_base64);

    // TODO: Agent dispatch will be inserted here
    // const agentResponse = await dispatchToAgent(transcribedText, validated.value.session_id);

    // TODO: TTS will be inserted here
    // const ttsAudio = await synthesizeSpeech(agentResponse);

    // For now, return a stub response
    const response: VoiceResponse = {
      text: "Voice webhook received",
      speak: true,
      tts_audio_base64: null,
    };

    sendJson(res, 200, response);
    return true;
  };
}
