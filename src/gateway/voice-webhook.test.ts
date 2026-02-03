import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createVoiceWebhookHandler,
  dispatchToAgent,
  transcribeAudio,
  type VoiceResponse,
} from "./voice-webhook.js";

// Mock dependencies
vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("../media-understanding/providers/openai/audio.js", () => ({
  transcribeOpenAiCompatibleAudio: vi.fn(),
}));

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithDispatcher: vi.fn(),
}));

vi.mock("../tts/tts.js", () => ({
  textToSpeech: vi.fn(),
}));

function createMockRequest(opts: {
  method?: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...opts.headers,
  };
  const req = {
    method: opts.method ?? "POST",
    url: opts.url ?? "/webhooks/voice",
    headers,
    on: vi.fn((event: string, cb: (data?: Buffer) => void) => {
      if (event === "data" && opts.body) {
        cb(Buffer.from(opts.body, "utf-8"));
      }
      if (event === "end") {
        cb();
      }
    }),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse & {
  getBody: () => unknown;
  getStatusCode: () => number;
} {
  let statusCode = 200;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    end: vi.fn((data?: string) => {
      body = data ?? "";
    }),
    getBody: () => (body ? JSON.parse(body) : null),
    getStatusCode: () => statusCode,
  } as unknown as ServerResponse & { getBody: () => unknown; getStatusCode: () => number };
  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v;
    },
  });
  return res;
}

function createMockConfig(overrides?: { voice?: { webhookToken?: string } }): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

describe("voice-webhook", () => {
  let mockResolveApiKey: Mock;
  let mockTranscribe: Mock;
  let mockDispatch: Mock;
  let mockTts: Mock;
  let mockCfg: OpenClawConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCfg = createMockConfig();

    // Reset environment
    delete process.env.OPENCLAW_VOICE_WEBHOOK_TOKEN;

    const authModule = await import("../agents/model-auth.js");
    const audioModule = await import("../media-understanding/providers/openai/audio.js");
    const dispatchModule = await import("../auto-reply/dispatch.js");
    const ttsModule = await import("../tts/tts.js");

    mockResolveApiKey = vi.mocked(authModule.resolveApiKeyForProvider);
    mockTranscribe = vi.mocked(audioModule.transcribeOpenAiCompatibleAudio);
    mockDispatch = vi.mocked(dispatchModule.dispatchInboundMessageWithDispatcher);
    mockTts = vi.mocked(ttsModule.textToSpeech);

    mockResolveApiKey.mockResolvedValue({
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    });
    mockTranscribe.mockResolvedValue({ text: "Hello world", model: "whisper-1" });
    mockDispatch.mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver({ text: "Agent response text" }, { kind: "final" });
      return { queuedFinal: 1, counts: { tool: 0, block: 0, final: 1 } };
    });
    mockTts.mockResolvedValue({ success: false, error: "TTS disabled" });
  });

  describe("authentication", () => {
    it("allows requests when no token is configured (dev mode)", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(200);
    });

    it("rejects requests without auth header when token is configured", async () => {
      const cfg = createMockConfig({ voice: { webhookToken: "secret-token" } });
      const handler = createVoiceWebhookHandler({ cfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(401);
      expect(res.getBody()).toEqual({ error: "Authorization header required" });
    });

    it("rejects requests with invalid token", async () => {
      const cfg = createMockConfig({ voice: { webhookToken: "secret-token" } });
      const handler = createVoiceWebhookHandler({ cfg });
      const req = createMockRequest({
        headers: { authorization: "Bearer wrong-token" },
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(401);
      expect(res.getBody()).toEqual({ error: "Invalid token" });
    });

    it("accepts requests with valid token", async () => {
      const cfg = createMockConfig({ voice: { webhookToken: "secret-token" } });
      const handler = createVoiceWebhookHandler({ cfg });
      const req = createMockRequest({
        headers: { authorization: "Bearer secret-token" },
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(200);
    });

    it("reads token from environment variable", async () => {
      process.env.OPENCLAW_VOICE_WEBHOOK_TOKEN = "env-token";
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        headers: { authorization: "Bearer env-token" },
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(200);
    });
  });

  describe("debug mode", () => {
    it("does not include transcription by default", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      const body = res.getBody() as VoiceResponse;
      expect(body.transcription).toBeUndefined();
    });

    it("includes transcription when X-OpenClaw-Debug header is set to 1", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        headers: { "x-openclaw-debug": "1" },
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      const body = res.getBody() as VoiceResponse;
      expect(body.transcription).toBe("Hello world");
    });

    it("includes transcription when X-OpenClaw-Debug header is set to true", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        headers: { "x-openclaw-debug": "true" },
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      const body = res.getBody() as VoiceResponse;
      expect(body.transcription).toBe("Hello world");
    });
  });

  describe("routing and validation", () => {
    it("returns false for non-matching paths", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({ url: "/other/path" });
      const res = createMockResponse();

      expect(await handler(req, res)).toBe(false);
    });

    it("rejects non-POST methods", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({ method: "GET" });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(405);
    });

    it("rejects missing session_id", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({ audio_base64: "dGVzdA==" }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "session_id must be a string" });
    });

    it("rejects missing audio_base64", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({ session_id: "test" }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "audio_base64 must be a string" });
    });
  });

  describe("STT error handling", () => {
    it("returns 400 for non-retryable STT errors", async () => {
      mockTranscribe.mockRejectedValue(new Error("Invalid audio format"));

      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(400);
    });

    it("returns 503 for rate limit errors (retryable)", async () => {
      mockTranscribe.mockRejectedValue(new Error("429 Too Many Requests"));

      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(503);
    });

    it("returns 503 for timeout errors (retryable)", async () => {
      mockTranscribe.mockRejectedValue(new Error("Request timed out"));

      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(503);
    });
  });

  describe("successful flow", () => {
    it("returns agent response with speak=true", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.getStatusCode()).toBe(200);
      const body = res.getBody() as VoiceResponse;
      expect(body.text).toBe("Agent response text");
      expect(body.speak).toBe(true);
      expect(body.tts_audio_base64).toBeNull();
    });

    it("includes tts_audio_base64 when TTS succeeds", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const tempDir = mkdtempSync(path.join(tmpdir(), "voice-tts-test-"));
      const audioPath = path.join(tempDir, "audio.wav");
      const audioBuffer = Buffer.from("test-audio");
      writeFileSync(audioPath, audioBuffer);
      mockTts.mockResolvedValueOnce({ success: true, audioPath });
      try {
        const req = createMockRequest({
          body: JSON.stringify({
            session_id: "test",
            audio_base64: Buffer.from("audio").toString("base64"),
          }),
        });
        const res = createMockResponse();

        await handler(req, res);

        const body = res.getBody() as VoiceResponse;
        expect(body.tts_audio_base64).toBe(audioBuffer.toString("base64"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("dispatches to agent with correct context", async () => {
      const handler = createVoiceWebhookHandler({ cfg: mockCfg });
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "my-session",
          audio_base64: Buffer.from("audio").toString("base64"),
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            Body: "Hello world",
            SessionKey: "my-session",
            Provider: "voice-terminal",
            Surface: "voice-terminal",
          }),
        }),
      );
    });
  });

  describe("transcribeAudio", () => {
    it("returns transcribed text on success", async () => {
      const result = await transcribeAudio({
        buffer: Buffer.from("audio"),
        mime: "audio/wav",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("Hello world");
      }
    });

    it("returns non-retryable error for API key failure", async () => {
      mockResolveApiKey.mockRejectedValue(new Error("No key"));

      const result = await transcribeAudio({
        buffer: Buffer.from("audio"),
        mime: "audio/wav",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
      }
    });

    it("returns retryable error for rate limits", async () => {
      mockTranscribe.mockRejectedValue(new Error("429 rate limit exceeded"));

      const result = await transcribeAudio({
        buffer: Buffer.from("audio"),
        mime: "audio/wav",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
      }
    });

    it("rejects audio exceeding size limit", async () => {
      const largeBuffer = Buffer.alloc(8 * 1024 * 1024); // 8MB

      const result = await transcribeAudio({
        buffer: largeBuffer,
        mime: "audio/wav",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("too large");
        expect(result.retryable).toBe(false);
      }
    });

    it("rejects empty audio buffer", async () => {
      const result = await transcribeAudio({
        buffer: Buffer.alloc(0),
        mime: "audio/wav",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("empty");
        expect(result.retryable).toBe(false);
      }
    });
  });

  describe("dispatchToAgent", () => {
    it("returns agent response on success", async () => {
      const result = await dispatchToAgent({
        text: "Hello",
        sessionId: "test",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("Agent response text");
      }
    });

    it("returns error when dispatch throws", async () => {
      mockDispatch.mockRejectedValue(new Error("Agent error"));

      const result = await dispatchToAgent({
        text: "Hello",
        sessionId: "test",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(false);
    });

    it("joins multiple response parts", async () => {
      mockDispatch.mockImplementation(async (params) => {
        await params.dispatcherOptions.deliver({ text: "Part 1" }, { kind: "block" });
        await params.dispatcherOptions.deliver({ text: "Part 2" }, { kind: "final" });
        return { queuedFinal: 2, counts: { tool: 0, block: 1, final: 1 } };
      });

      const result = await dispatchToAgent({
        text: "Hello",
        sessionId: "test",
        cfg: mockCfg,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("Part 1\n\nPart 2");
      }
    });
  });
});
